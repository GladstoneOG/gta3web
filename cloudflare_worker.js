/**
 * Grand Theft Auto III Web — Cloudflare Worker + Durable Object Relay
 * ====================================================================
 * Serves static GTA III Web assets (HTML, re3 WASM engine, compressed 3D assets, audio)
 * and hosts a global 8-player low-latency multiplayer relay hub inside a Durable Object
 * (`GTA3RelayHub`).
 *
 * Fully compatible with the Cloudflare Workers Free Plan via SQLite Durable Objects
 * (`new_sqlite_classes = ["GTA3RelayHub"]`).
 *
 * Endpoints:
 *   GET /api/info   -> { ok: true, mode: "cloudflare-durable-object", service: "GTA III Web Multiplayer Relay", activeRooms, defaultRoomPort }
 *   GET /api/rooms  -> { rooms: [...] }
 *   WS  /api/ws     -> Upgrades to WebSocket, connects to GTA3RelayHub
 *   Static assets   -> env.ASSETS.fetch(request)
 */

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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

function parseRoomPort(raw, fallback = DEFAULT_ROOM_PORT) {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (Number.isFinite(n) && n >= MIN_ROOM_PORT && n <= MAX_ROOM_PORT) {
    return n;
  }
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
  const buf = new Uint8Array(4);
  buf[0] = FRAME_HOST_ASSIGNED;
  buf[1] = (port >> 8) & 0xff;
  buf[2] = port & 0xff;
  buf[3] = peerId & 0xff;
  return buf;
}

function encodePeerConnectedFrame(peerId, name) {
  const nameBytes = new TextEncoder().encode(String(name || ""));
  const buf = new Uint8Array(4 + nameBytes.length);
  buf[0] = FRAME_PEER_CONNECTED;
  buf[1] = (peerId >> 8) & 0xff;
  buf[2] = peerId & 0xff;
  buf[3] = 0;
  buf.set(nameBytes, 4);
  return buf;
}

function encodePeerDisconnectedFrame(peerId) {
  const buf = new Uint8Array(4);
  buf[0] = FRAME_PEER_DISCONNECTED;
  buf[1] = (peerId >> 8) & 0xff;
  buf[2] = peerId & 0xff;
  buf[3] = 0;
  return buf;
}

function encodeRoomInfoFrame(summary) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(summary));
  const buf = new Uint8Array(4 + jsonBytes.length);
  buf[0] = FRAME_ROOM_INFO;
  buf[1] = 0;
  buf[2] = 0;
  buf[3] = 0;
  buf.set(jsonBytes, 4);
  return buf;
}

function encodeRejectedFrame(reason) {
  const reasonBytes = new TextEncoder().encode(String(reason || ""));
  const buf = new Uint8Array(4 + reasonBytes.length);
  buf[0] = FRAME_REJECTED;
  buf[1] = 0;
  buf[2] = 0;
  buf[3] = 0;
  buf.set(reasonBytes, 4);
  return buf;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const upgradeHeader = request.headers.get("Upgrade") || "";
    if (
      upgradeHeader.toLowerCase() === "websocket" ||
      url.pathname.startsWith("/api/") ||
      url.pathname === "/ws"
    ) {
      const id = env.RELAY_HUB.idFromName("global-gta3-hub");
      const stub = env.RELAY_HUB.get(id);
      return stub.fetch(request);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("GTA III Web Relay Worker is online.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
    });
  },
};

export class GTA3RelayHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /**
     * Map<port, {
     *   port: number,
     *   name: string,
     *   mode: string,
     *   island: number,
     *   weather: number,
     *   createdAt: number,
     *   peers: Map<peerId (1..8), { ws: WebSocket, peerId: number, name: string, joinedAt: number }>
     * }>
     */
    this.rooms = new Map();
    /**
     * Map<WebSocket, { port: number, peerId: number, name: string, joinedAt: number }>
     */
    this.peers = new Map();
  }

  getRoomSummary(room) {
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

  getRoomSummaries() {
    const list = [];
    for (const [port, room] of this.rooms.entries()) {
      if (room.peers.size === 0) {
        this.rooms.delete(port);
        continue;
      }
      list.push(this.getRoomSummary(room));
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }

  broadcastRoomInfo(room) {
    const summary = this.getRoomSummary(room);
    const frame = encodeRoomInfoFrame(summary);
    for (const [, peer] of room.peers.entries()) {
      this.safeSend(peer.ws, frame);
    }
  }

  safeSend(ws, data) {
    try {
      ws.send(data);
    } catch (_) {}
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/info") {
      const roomList = this.getRoomSummaries();
      return Response.json(
        {
          ok: true,
          mode: "cloudflare-durable-object",
          service: "GTA III Web Multiplayer Relay",
          activeRooms: roomList.length,
          defaultRoomPort: DEFAULT_ROOM_PORT,
        },
        { headers: { "Cache-Control": "no-store", ...CORS_HEADERS } }
      );
    }

    if (url.pathname === "/api/rooms") {
      return Response.json(
        { rooms: this.getRoomSummaries() },
        { headers: { "Cache-Control": "no-store", ...CORS_HEADERS } }
      );
    }

    const upgradeHeader = request.headers.get("Upgrade") || "";
    if (upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket Upgrade", { status: 426, headers: CORS_HEADERS });
    }

    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);
    serverSocket.accept();

    const port = parseRoomPort(url.searchParams.get("room"), DEFAULT_ROOM_PORT);
    const requestedName = url.searchParams.get("name");
    const requestedRoomName = url.searchParams.get("roomName") || url.searchParams.get("title");
    const requestedMode = sanitizeMode(url.searchParams.get("mode"));
    const requestedIsland = sanitizeNumber(url.searchParams.get("island"), 1, 1, 3);
    const requestedWeather = sanitizeNumber(url.searchParams.get("weather"), 0, 0, 3);
    const requestedRole = (url.searchParams.get("role") || "auto").toLowerCase();

    let room = this.rooms.get(port);
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
      this.rooms.set(port, room);
    } else {
      if (requestedRoomName && !room.peers.has(1)) {
        room.name = sanitizeRoomName(requestedRoomName, port);
      }
    }

    let assignedPeerId = null;
    if (requestedRole === "host") {
      if (room.peers.has(1)) {
        this.safeSend(serverSocket, encodeRejectedFrame(`Room ${port} already has a Host.`));
        serverSocket.close(1008, "Room already has a host");
        return new Response(null, { status: 101, webSocket: clientSocket });
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
        this.safeSend(serverSocket, encodeRejectedFrame(`Room ${port} is full (${MAX_PLAYERS_PER_ROOM}/${MAX_PLAYERS_PER_ROOM} players).`));
        serverSocket.close(1008, "Room is full");
        return new Response(null, { status: 101, webSocket: clientSocket });
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
        this.safeSend(serverSocket, encodeRejectedFrame(`Room ${port} is full (${MAX_PLAYERS_PER_ROOM}/${MAX_PLAYERS_PER_ROOM} players).`));
        serverSocket.close(1008, "Room is full");
        return new Response(null, { status: 101, webSocket: clientSocket });
      }
    }

    const playerName = sanitizePlayerName(requestedName, assignedPeerId);
    const peerRecord = {
      ws: serverSocket,
      peerId: assignedPeerId,
      name: playerName,
      joinedAt: Date.now(),
    };

    // 1. Send FRAME_HOST_ASSIGNED to connecting socket immediately
    this.safeSend(serverSocket, encodeHostAssignedFrame(port, assignedPeerId));

    // 2. Send existing peer roster to the newly joined peer
    for (const [, existingPeer] of room.peers.entries()) {
      this.safeSend(serverSocket, encodePeerConnectedFrame(existingPeer.peerId, existingPeer.name));
    }

    // 3. Register peer in room and peer lookup map
    room.peers.set(assignedPeerId, peerRecord);
    this.peers.set(serverSocket, { port, peerId: assignedPeerId, name: playerName, joinedAt: peerRecord.joinedAt });

    // 4. Notify existing peers that a new peer connected
    const newPeerFrame = encodePeerConnectedFrame(assignedPeerId, playerName);
    for (const [id, peer] of room.peers.entries()) {
      if (id !== assignedPeerId) {
        this.safeSend(peer.ws, newPeerFrame);
      }
    }

    // 5. Broadcast updated room info
    this.broadcastRoomInfo(room);

    serverSocket.addEventListener("message", (event) => {
      this.handleMessage(serverSocket, event.data);
    });

    const onDisconnect = () => {
      this.handleDisconnect(serverSocket);
    };
    serverSocket.addEventListener("close", onDisconnect);
    serverSocket.addEventListener("error", onDisconnect);

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  handleMessage(ws, rawData) {
    const peer = this.peers.get(ws);
    if (!peer) return;
    const room = this.rooms.get(peer.port);
    if (!room) return;

    let bytes;
    if (rawData instanceof ArrayBuffer) {
      bytes = new Uint8Array(rawData);
    } else if (ArrayBuffer.isView(rawData)) {
      bytes = new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    } else if (typeof rawData === "string") {
      bytes = new TextEncoder().encode(rawData);
    } else {
      return;
    }

    if (bytes.length < 4) return;
    const frameType = bytes[0];
    const targetOrPeerId = (bytes[1] << 8) | bytes[2];
    const channel = bytes[3];

    if (frameType === FRAME_DATA) {
      if (peer.peerId === 1) {
        // Sent by Host
        const targetPeerId = targetOrPeerId;
        const out = new Uint8Array(bytes);
        out[1] = 0;
        out[2] = 1; // stamped sender = Host (1)

        if (targetPeerId === 0) {
          // Broadcast to all clients in room
          for (const [id, p] of room.peers.entries()) {
            if (id !== 1) this.safeSend(p.ws, out);
          }
        } else {
          // Unicast to target client
          const client = room.peers.get(targetPeerId);
          if (client) this.safeSend(client.ws, out);
        }
      } else {
        // Sent by Client
        const targetPeerId = targetOrPeerId;
        const out = new Uint8Array(bytes);
        out[1] = (peer.peerId >> 8) & 0xff;
        out[2] = peer.peerId & 0xff; // stamped sender = client's peerId

        if (channel === 2) {
          // Fast peer-to-peer broadcast to all other peers in room
          for (const [id, p] of room.peers.entries()) {
            if (id !== peer.peerId) this.safeSend(p.ws, out);
          }
        } else if (
          (channel === 3 || (bytes.length > 4 && bytes[4] === 0x30)) &&
          targetPeerId >= 1 &&
          targetPeerId !== peer.peerId
        ) {
          // Direct 1-hop unicast to target peer (WebRTC signaling & targeted relay packets)
          const dest = room.peers.get(targetPeerId);
          if (dest) this.safeSend(dest.ws, out);
        } else {
          // Forward to Host (peer 1)
          const host = room.peers.get(1);
          if (host) this.safeSend(host.ws, out);
        }
      }
      return;
    }

    if (frameType === FRAME_KICK_PEER && peer.peerId === 1) {
      const targetId = targetOrPeerId;
      if (targetId >= 2 && room.peers.has(targetId)) {
        const target = room.peers.get(targetId);
        this.safeSend(target.ws, encodeRejectedFrame("Kicked by Host"));
        try { target.ws.close(1008, "Kicked by Host"); } catch (_) {}
        this.handleDisconnect(target.ws);
      }
      return;
    }

    if (frameType === FRAME_ROOM_INFO && peer.peerId === 1 && bytes.length > 4) {
      try {
        const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4)));
        if (meta.name) room.name = sanitizeRoomName(meta.name, room.port);
        if (meta.mode) room.mode = sanitizeMode(meta.mode);
        if (typeof meta.island === "number") room.island = sanitizeNumber(meta.island, 1, 1, 3);
        if (typeof meta.weather === "number") room.weather = sanitizeNumber(meta.weather, 0, 0, 3);
        this.broadcastRoomInfo(room);
      } catch (_) {}
    }
  }

  handleDisconnect(ws) {
    const peer = this.peers.get(ws);
    if (!peer) return;
    this.peers.delete(ws);

    const room = this.rooms.get(peer.port);
    if (!room) return;

    room.peers.delete(peer.peerId);

    // 1. Notify remaining peers that this peer disconnected
    const discFrame = encodePeerDisconnectedFrame(peer.peerId);
    for (const [, p] of room.peers.entries()) {
      this.safeSend(p.ws, discFrame);
    }

    // 2. If Host disconnected and clients remain: promote oldest client to Host (slot 1)
    if (peer.peerId === 1 && room.peers.size > 0) {
      let nextHost = null;
      for (const [, p] of room.peers.entries()) {
        if (!nextHost || p.joinedAt < nextHost.joinedAt) {
          nextHost = p;
        }
      }
      if (nextHost) {
        const oldId = nextHost.peerId;
        room.peers.delete(oldId);

        // Notify remaining peers that old client ID disconnected
        const oldIdDiscFrame = encodePeerDisconnectedFrame(oldId);
        for (const [, p] of room.peers.entries()) {
          if (p.ws !== nextHost.ws) {
            this.safeSend(p.ws, oldIdDiscFrame);
          }
        }

        nextHost.peerId = 1;
        room.peers.set(1, nextHost);
        this.peers.set(nextHost.ws, { ...nextHost, port: room.port });

        // Tell promoted client it is now Host
        this.safeSend(nextHost.ws, encodeHostAssignedFrame(room.port, 1));

        // Notify all peers of new host
        const newHostFrame = encodePeerConnectedFrame(1, nextHost.name);
        for (const [, p] of room.peers.entries()) {
          this.safeSend(p.ws, newHostFrame);
        }
      }
    }

    // 3. Clean up empty rooms or broadcast updated room info
    if (room.peers.size === 0) {
      this.rooms.delete(room.port);
    } else {
      this.broadcastRoomInfo(room);
    }
  }
}
