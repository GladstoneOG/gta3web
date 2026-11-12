#!/usr/bin/env node
/**
 * Grand Theft Auto III Web — Local Development & Multiplayer Relay Server
 * =========================================================================
 * Mirrors the exact protocol and endpoints of `cloudflare_worker.js` (`GTA3RelayHub`)
 * so local development (`node server.js` / `npm start`) behaves identically
 * to production Cloudflare Workers + Durable Objects.
 *
 * Features:
 *   - Zero external dependencies (native Node.js `http`, `fs`, `path`, `crypto`).
 *   - Fast 8-player binary WebSocket relay supporting Host migration and P2P broadcast.
 *   - Serves static assets from `./public` with full MIME support & HTTP Range (206) streaming.
 *   - Cross-Origin Isolation headers for WebAssembly & high-precision timers.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = path.join(__dirname, "public");
const CDN_FALLBACK_ORIGIN = (process.env.CDN_ORIGIN || "https://gta3web.johansans999.workers.dev").replace(/\/+$/, "");

const FRAME_DATA = 0x01;
const FRAME_PEER_CONNECTED = 0x02;
const FRAME_PEER_DISCONNECTED = 0x03;
const FRAME_KICK_PEER = 0x04;
const FRAME_ROOM_INFO = 0x05;
const FRAME_HOST_ASSIGNED = 0x06;
const FRAME_REJECTED = 0x07;

const DEFAULT_ROOM_PORT = 7777;
const MIN_ROOM_PORT = 1024;
const MAX_ROOM_PORT = 65535;
const MAX_PLAYERS_PER_ROOM = 8;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".data": "application/octet-stream",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

/**
 * Lightweight RFC 6455 WebSocket wrapper over a raw Node.js net.Socket
 */
class MiniWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.onMessage = null;
    this.onClose = null;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("end", () => this._emitClose());
    socket.on("close", () => this._emitClose());
    socket.on("error", () => this._emitClose());
  }

  _emitClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (payloadLen > 16 * 1024 * 1024) {
        this.close(1009, "Frame too large");
        return;
      }
      if (this.buffer.length < offset + maskLen + payloadLen) return;

      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x08) {
        // Close frame
        this.close();
        return;
      } else if (opcode === 0x09) {
        // Ping -> Pong
        this._sendFrame(0x0a, payload);
      } else if (opcode === 0x0a) {
        // Pong
      } else if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
        if (opcode !== 0x00) {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        } else {
          this.fragments.push(payload);
        }
        if (fin) {
          const fullPayload = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.onMessage) {
            this.onMessage(fullPayload);
          }
        }
      }
    }
  }

  _sendFrame(opcode, dataBuffer) {
    if (this.closed || !this.socket.writable) return;
    const len = dataBuffer.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, dataBuffer]));
    } catch (_) {
      this._emitClose();
    }
  }

  send(uint8OrBuffer) {
    const buf = Buffer.isBuffer(uint8OrBuffer)
      ? uint8OrBuffer
      : Buffer.from(uint8OrBuffer.buffer, uint8OrBuffer.byteOffset, uint8OrBuffer.byteLength);
    this._sendFrame(0x02, buf);
  }

  close(code, reason) {
    if (this.closed) return;
    try {
      let payload = Buffer.alloc(0);
      if (typeof code === "number") {
        const reasonBuf = reason ? Buffer.from(String(reason), "utf-8") : Buffer.alloc(0);
        payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);
      }
      this._sendFrame(0x08, payload);
      this.socket.end();
    } catch (_) {}
    this._emitClose();
  }
}

/**
 * Global room state
 * Map<port, {
 *   port: number,
 *   name: string,
 *   mode: string,
 *   island: number,
 *   weather: number,
 *   createdAt: number,
 *   peers: Map<peerId (1..8), { ws: MiniWebSocket, peerId: number, name: string, joinedAt: number }>
 * }>
 */
const rooms = new Map();
const peers = new Map(); // ws -> { port, peerId, name, joinedAt }

function parseRoomPort(raw, fallback = DEFAULT_ROOM_PORT) {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (Number.isFinite(n) && n >= MIN_ROOM_PORT && n <= MAX_ROOM_PORT) return n;
  return fallback;
}

function sanitizeRoomName(raw, port) {
  const cleaned = String(raw || "")
    .replace(/[\r\n\t<>]/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || `Liberty City #${port}`;
}

function sanitizePlayerName(raw, peerId) {
  const cleaned = String(raw || "")
    .replace(/[\r\n\t<>]/g, " ")
    .trim()
    .slice(0, 24);
  return cleaned || `Player ${peerId}`;
}

function sanitizeMode(raw) {
  const cleaned = String(raw || "").trim().toLowerCase();
  const valid = new Set(["freeroam", "deathmatch", "cops_and_robbers", "race"]);
  return valid.has(cleaned) ? cleaned : "freeroam";
}

function sanitizeNumber(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw), 10);
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  return fallback;
}

function encodeHostAssignedFrame(port, peerId) {
  const buf = Buffer.alloc(4);
  buf[0] = FRAME_HOST_ASSIGNED;
  buf[1] = (port >> 8) & 0xff;
  buf[2] = port & 0xff;
  buf[3] = peerId & 0xff;
  return buf;
}

function encodePeerConnectedFrame(peerId, name) {
  const nameBytes = Buffer.from(String(name || ""), "utf-8");
  const buf = Buffer.alloc(4 + nameBytes.length);
  buf[0] = FRAME_PEER_CONNECTED;
  buf[1] = (peerId >> 8) & 0xff;
  buf[2] = peerId & 0xff;
  buf[3] = 0;
  nameBytes.copy(buf, 4);
  return buf;
}

function encodePeerDisconnectedFrame(peerId) {
  const buf = Buffer.alloc(4);
  buf[0] = FRAME_PEER_DISCONNECTED;
  buf[1] = (peerId >> 8) & 0xff;
  buf[2] = peerId & 0xff;
  buf[3] = 0;
  return buf;
}

function encodeRoomInfoFrame(summary) {
  const jsonBytes = Buffer.from(JSON.stringify(summary), "utf-8");
  const buf = Buffer.alloc(4 + jsonBytes.length);
  buf[0] = FRAME_ROOM_INFO;
  buf[1] = 0;
  buf[2] = 0;
  buf[3] = 0;
  jsonBytes.copy(buf, 4);
  return buf;
}

function encodeRejectedFrame(reason) {
  const reasonBytes = Buffer.from(String(reason || ""), "utf-8");
  const buf = Buffer.alloc(4 + reasonBytes.length);
  buf[0] = FRAME_REJECTED;
  buf[1] = 0;
  buf[2] = 0;
  buf[3] = 0;
  reasonBytes.copy(buf, 4);
  return buf;
}

function getRoomSummary(room) {
  const players = [];
  for (const [peerId, peer] of room.peers.entries()) {
    players.push({
      peerId,
      name: peer.name,
      isHost: peerId === 1,
    });
  }
  players.sort((a, b) => a.peerId - b.peerId);

  const hostPeer = room.peers.get(1);
  return {
    port: room.port,
    name: room.name,
    mode: room.mode,
    island: room.island,
    weather: room.weather,
    playerCount: room.peers.size,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    hostName: hostPeer ? hostPeer.name : "None",
    createdAt: room.createdAt,
    players,
  };
}

function getRoomSummaries() {
  const list = [];
  for (const [port, room] of rooms.entries()) {
    if (room.peers.size === 0) {
      rooms.delete(port);
      continue;
    }
    list.push(getRoomSummary(room));
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

function broadcastRoomInfo(room) {
  const summary = getRoomSummary(room);
  const frame = encodeRoomInfoFrame(summary);
  for (const [, peer] of room.peers.entries()) {
    peer.ws.send(frame);
  }
}

function handleStaticFile(req, res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const range = req.headers.range;
  const baseHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };

  if (req.method === "HEAD") {
    res.writeHead(200, {
      ...baseHeaders,
      "Content-Length": stat.size,
    });
    res.end();
    return;
  }

  if (range && stat.size > 0) {
    const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = rangeMatch && rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : NaN;
    let end = rangeMatch && rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : NaN;

    if (!rangeMatch || (Number.isNaN(start) && Number.isNaN(end))) {
      res.writeHead(416, {
        "Content-Range": `bytes */${stat.size}`,
        "Access-Control-Allow-Origin": "*",
      });
      res.end();
      return;
    }

    if (Number.isNaN(start)) {
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    } else if (Number.isNaN(end)) {
      end = stat.size - 1;
    }

    if (start > end || start >= stat.size || end >= stat.size || start < 0) {
      res.writeHead(416, {
        "Content-Range": `bytes */${stat.size}`,
        "Access-Control-Allow-Origin": "*",
      });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": chunkSize,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      ...baseHeaders,
      "Content-Length": stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/info") {
    const roomList = getRoomSummaries();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({
        ok: true,
        mode: "local-node-relay",
        service: "GTA III Web Multiplayer Relay",
        activeRooms: roomList.length,
        defaultRoomPort: DEFAULT_ROOM_PORT,
      })
    );
    return;
  }

  if (url.pathname === "/api/rooms") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ rooms: getRoomSummaries() }));
    return;
  }

  if (url.pathname === "/api/ws" || url.pathname === "/ws") {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Expected WebSocket Upgrade");
    return;
  }

  let reqPath;
  try {
    reqPath = decodeURIComponent(url.pathname);
  } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request");
    return;
  }
  if (reqPath === "/") reqPath = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Transparent CDN proxy fallback for large asset slices & audio tracks not stored locally in git
      if ((reqPath.startsWith("/chunks/") || reqPath.startsWith("/audio/")) && CDN_FALLBACK_ORIGIN) {
        const targetUrl = `${CDN_FALLBACK_ORIGIN}${reqPath}`;
        const proxyHeaders = { "User-Agent": "GTA3Web-LocalRelay/1.0" };
        if (req.headers.range) proxyHeaders.Range = req.headers.range;
        const proxyReq = https.get(targetUrl, { headers: proxyHeaders }, (proxyRes) => {
          if (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 206) {
            res.writeHead(proxyRes.statusCode || 404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            proxyRes.resume();
            return;
          }
          const ext = path.extname(reqPath).toLowerCase();
          const outHeaders = {
            "Content-Type": proxyRes.headers["content-type"] || MIME_TYPES[ext] || "application/octet-stream",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
          };
          if (proxyRes.headers["content-length"]) outHeaders["Content-Length"] = proxyRes.headers["content-length"];
          if (proxyRes.headers["content-range"]) outHeaders["Content-Range"] = proxyRes.headers["content-range"];
          if (proxyRes.headers["accept-ranges"]) outHeaders["Accept-Ranges"] = proxyRes.headers["accept-ranges"];
          res.writeHead(proxyRes.statusCode, outHeaders);
          proxyRes.pipe(res);
        });
        proxyReq.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain" });
          }
          res.end("Upstream CDN unreachable");
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    handleStaticFile(req, res, filePath, stat);
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ].join("\r\n")
  );

  const ws = new MiniWebSocket(socket);
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const port = parseRoomPort(url.searchParams.get("room"), DEFAULT_ROOM_PORT);
  const requestedName = url.searchParams.get("name");
  const requestedRoomName = url.searchParams.get("roomName") || url.searchParams.get("title");
  const requestedMode = sanitizeMode(url.searchParams.get("mode"));
  const requestedIsland = sanitizeNumber(url.searchParams.get("island"), 1, 1, 3);
  const requestedWeather = sanitizeNumber(url.searchParams.get("weather"), 0, 0, 3);
  const requestedRole = (url.searchParams.get("role") || "auto").toLowerCase();

  let room = rooms.get(port);
  if (!room) {
    room = {
      port,
      name: sanitizeRoomName(requestedRoomName, port),
      mode: requestedMode,
      island: requestedIsland,
      weather: requestedWeather,
      createdAt: Date.now(),
      peers: new Map(),
    };
    rooms.set(port, room);
  } else {
    if (requestedRoomName && !room.peers.has(1)) {
      room.name = sanitizeRoomName(requestedRoomName, port);
    }
  }

  let assignedPeerId = null;
  if (requestedRole === "host") {
    if (room.peers.has(1)) {
      ws.send(encodeRejectedFrame(`Room ${port} already has a Host.`));
      ws.close(1008, "Room already has a host");
      return;
    }
    assignedPeerId = 1;
  } else if (requestedRole === "client") {
    for (let id = 2; id <= MAX_PLAYERS_PER_ROOM; id++) {
      if (!room.peers.has(id)) {
        assignedPeerId = id;
        break;
      }
    }
    if (!assignedPeerId) {
      ws.send(encodeRejectedFrame(`Room ${port} is full (${MAX_PLAYERS_PER_ROOM}/${MAX_PLAYERS_PER_ROOM} players).`));
      ws.close(1008, "Room is full");
      return;
    }
  } else {
    // Auto: host slot if empty, otherwise first available client slot 2..8
    if (!room.peers.has(1)) {
      assignedPeerId = 1;
    } else {
      for (let id = 2; id <= MAX_PLAYERS_PER_ROOM; id++) {
        if (!room.peers.has(id)) {
          assignedPeerId = id;
          break;
        }
      }
    }
    if (!assignedPeerId) {
      ws.send(encodeRejectedFrame(`Room ${port} is full (${MAX_PLAYERS_PER_ROOM}/${MAX_PLAYERS_PER_ROOM} players).`));
      ws.close(1008, "Room is full");
      return;
    }
  }

  const playerName = sanitizePlayerName(requestedName, assignedPeerId);
  const peerRecord = {
    ws,
    peerId: assignedPeerId,
    name: playerName,
    joinedAt: Date.now(),
  };

  // 1. Send FRAME_HOST_ASSIGNED immediately to connecting socket
  ws.send(encodeHostAssignedFrame(port, assignedPeerId));

  // 2. Send existing peer roster to newly joined socket
  for (const [, existingPeer] of room.peers.entries()) {
    ws.send(encodePeerConnectedFrame(existingPeer.peerId, existingPeer.name));
  }

  // 3. Register peer in room and peer lookup map
  room.peers.set(assignedPeerId, peerRecord);
  peers.set(ws, { port, peerId: assignedPeerId, name: playerName, joinedAt: peerRecord.joinedAt });

  // 4. Notify existing peers of newly joined peer
  const newPeerFrame = encodePeerConnectedFrame(assignedPeerId, playerName);
  for (const [id, peer] of room.peers.entries()) {
    if (id !== assignedPeerId) {
      peer.ws.send(newPeerFrame);
    }
  }

  // 5. Broadcast updated room info to all peers
  broadcastRoomInfo(room);

  ws.onMessage = (bytes) => {
    const peer = peers.get(ws);
    if (!peer || bytes.length < 4) return;
    const r = rooms.get(peer.port);
    if (!r) return;

    const frameType = bytes[0];
    const targetOrPeerId = (bytes[1] << 8) | bytes[2];
    const channel = bytes[3];

    if (frameType === FRAME_DATA) {
      if (peer.peerId === 1) {
        // Sent by Host
        const targetPeerId = targetOrPeerId;
        const out = Buffer.from(bytes);
        out[1] = 0;
        out[2] = 1; // stamped sender = Host (1)

        if (targetPeerId === 0) {
          // Broadcast to all clients in room
          for (const [id, p] of r.peers.entries()) {
            if (id !== 1) p.ws.send(out);
          }
        } else {
          // Unicast to target client
          const client = r.peers.get(targetPeerId);
          if (client) client.ws.send(out);
        }
      } else {
        // Sent by Client
        const targetPeerId = targetOrPeerId;
        const out = Buffer.from(bytes);
        out[1] = (peer.peerId >> 8) & 0xff;
        out[2] = peer.peerId & 0xff; // stamped sender = client's peerId

        if (channel === 2) {
          // Fast peer-to-peer broadcast to all other peers in room
          for (const [id, p] of r.peers.entries()) {
            if (id !== peer.peerId) p.ws.send(out);
          }
        } else if (
          (channel === 3 || (bytes.length > 4 && bytes[4] === 0x30)) &&
          targetPeerId >= 1 &&
          targetPeerId !== peer.peerId
        ) {
          // Direct 1-hop unicast to target peer (used for WebRTC signaling & targeted relay packets)
          const dest = r.peers.get(targetPeerId);
          if (dest) dest.ws.send(out);
        } else {
          // Forward to Host (peer 1)
          const host = r.peers.get(1);
          if (host) host.ws.send(out);
        }
      }
      return;
    }

    if (frameType === FRAME_KICK_PEER && peer.peerId === 1) {
      const targetId = targetOrPeerId;
      if (targetId >= 2 && r.peers.has(targetId)) {
        const target = r.peers.get(targetId);
        target.ws.send(encodeRejectedFrame("Kicked by Host"));
        target.ws.close(1008, "Kicked by Host");
      }
      return;
    }

    if (frameType === FRAME_ROOM_INFO && peer.peerId === 1 && bytes.length > 4) {
      try {
        const meta = JSON.parse(bytes.subarray(4).toString("utf-8"));
        if (meta.name) r.name = sanitizeRoomName(meta.name, r.port);
        if (meta.mode) r.mode = sanitizeMode(meta.mode);
        if (typeof meta.island === "number") r.island = sanitizeNumber(meta.island, 1, 1, 3);
        if (typeof meta.weather === "number") r.weather = sanitizeNumber(meta.weather, 0, 0, 3);
        broadcastRoomInfo(r);
      } catch (_) {}
    }
  };

  ws.onClose = () => {
    const peer = peers.get(ws);
    if (!peer) return;
    peers.delete(ws);

    const r = rooms.get(peer.port);
    if (!r) return;

    r.peers.delete(peer.peerId);

    // 1. Notify remaining peers that this peer disconnected
    const discFrame = encodePeerDisconnectedFrame(peer.peerId);
    for (const [, p] of r.peers.entries()) {
      p.ws.send(discFrame);
    }

    // 2. If Host disconnected and clients remain: promote oldest active client to Host (slot 1)
    if (peer.peerId === 1 && r.peers.size > 0) {
      let nextHost = null;
      for (const [, p] of r.peers.entries()) {
        if (p.ws && !p.ws.closed && (!nextHost || p.joinedAt < nextHost.joinedAt)) {
          nextHost = p;
        }
      }
      if (nextHost) {
        const oldId = nextHost.peerId;
        r.peers.delete(oldId);

        // Notify remaining peers that old client ID disconnected
        const oldIdDiscFrame = encodePeerDisconnectedFrame(oldId);
        for (const [, p] of r.peers.entries()) {
          if (p.ws !== nextHost.ws) {
            p.ws.send(oldIdDiscFrame);
          }
        }

        nextHost.peerId = 1;
        r.peers.set(1, nextHost);
        peers.set(nextHost.ws, {
          port: r.port,
          peerId: 1,
          name: nextHost.name,
          joinedAt: nextHost.joinedAt,
        });

        // Tell promoted client it is now Host
        nextHost.ws.send(encodeHostAssignedFrame(r.port, 1));

        // Notify all peers of new host
        const newHostFrame = encodePeerConnectedFrame(1, nextHost.name);
        for (const [, p] of r.peers.entries()) {
          p.ws.send(newHostFrame);
        }
      }
    }

    // 3. Clean up empty rooms or broadcast updated room info
    if (r.peers.size === 0) {
      rooms.delete(r.port);
    } else {
      broadcastRoomInfo(r);
    }
  };
});

// Periodic WebSocket Ping keepalive to prevent idle proxy timeouts and prune dead sockets
const keepaliveTimer = setInterval(() => {
  const pingPayload = Buffer.alloc(0);
  for (const [ws] of peers.entries()) {
    if (ws.closed || !ws.socket || !ws.socket.writable) {
      ws._emitClose();
    } else {
      ws._sendFrame(0x09, pingPayload);
    }
  }
}, 25000);
if (keepaliveTimer.unref) keepaliveTimer.unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n========================================================`);
  console.log(`  GRAND THEFT AUTO III WEB — 8-PLAYER MULTIPLAYER HUB`);
  console.log(`  Local URL:  http://localhost:${PORT}`);
  console.log(`  Co-op Hub:  ws://localhost:${PORT}/api/ws?room=7777`);
  console.log(`========================================================\n`);
});
