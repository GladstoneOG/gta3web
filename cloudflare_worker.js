/**
 * GTA III Web — Cloudflare Worker + SQLite Durable Object (`Gta3RelayHub`)
 * ========================================================================
 * Serves static assets via Workers Static Assets and routes `/api/*` + `/ws`
 * to a single SQLite-backed Durable Object (`Gta3RelayHub`, Free Plan compatible):
 *   1. 4-Player Co-op Binary Relay + Room Browser + WebRTC Signaling (`FRAME_WEBRTC_SIGNAL`)
 *   2. PBKDF2-SHA256 User Accounts & Bearer Sessions in `ctx.storage.sql`
 *   3. Co-op Campaign Save/Load CRUD (`campaigns` + 4 `campaign_slots` per campaign)
 */

const FRAME_DATA = 1;
const FRAME_PEER_CONNECTED = 2;
const FRAME_PEER_DISCONNECTED = 3;
const FRAME_KICK_PEER = 4;
const FRAME_ROOM_INFO = 5;
const FRAME_HOST_ASSIGNED = 6;
const FRAME_REJECTED = 7;
const FRAME_WEBRTC_SIGNAL = 8;

const DEFAULT_ROOM_PORT = 7777;
const MIN_ROOM_PORT = 1024;
const MAX_ROOM_PORT = 65535;
const MAX_CLIENTS_PER_ROOM = 3; // 1 Host (peerId=1) + up to 3 Clients (peerId=2..4)
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const VALID_MODES = new Set(["story_coop", "open_sandbox"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

function makeFrame(type, peerId, channel, payloadBytes) {
  const payload = payloadBytes
    ? payloadBytes instanceof Uint8Array
      ? payloadBytes
      : new Uint8Array(payloadBytes)
    : new Uint8Array(0);
  const out = new Uint8Array(4 + payload.byteLength);
  out[0] = type & 0xff;
  out[1] = (peerId >> 8) & 0xff;
  out[2] = peerId & 0xff;
  out[3] = channel & 0xff;
  if (payload.byteLength > 0) {
    out.set(payload, 4);
  }
  return out;
}

function parseRoomPort(raw, fallback = DEFAULT_ROOM_PORT) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (Number.isFinite(n) && n >= MIN_ROOM_PORT && n <= MAX_ROOM_PORT) return n;
  return fallback;
}

function sanitizeText(raw, maxLen, fallback) {
  const cleaned = String(raw ?? "")
    .replace(/[\r\n\t<>]/g, " ")
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

function sanitizeMode(raw) {
  const cleaned = String(raw ?? "").trim().toLowerCase();
  return VALID_MODES.has(cleaned) ? cleaned : "story_coop";
}

function clampInt(val, min, max, fallback) {
  const n = Number.parseInt(String(val ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNum(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex) {
  const len = hex.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function timingSafeEqualHex(aHex, bHex) {
  if (typeof aHex !== "string" || typeof bHex !== "string" || aHex.length !== bHex.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aHex.length; i++) {
    diff |= aHex.charCodeAt(i) ^ bHex.charCodeAt(i);
  }
  return diff === 0;
}

async function hashPassword(password, saltHex) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    utf8Encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

function generateHexToken(byteLen = 32) {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

async function readJsonBody(request) {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number.parseInt(lenHeader, 10) > MAX_JSON_BODY_BYTES) {
    return { error: "Payload too large", status: 413 };
  }
  let text;
  try {
    text = await request.text();
  } catch (_) {
    return { error: "Failed to read request body", status: 400 };
  }
  if (utf8Encoder.encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    return { error: "Payload too large", status: 413 };
  }
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "JSON body must be an object", status: 400 };
    }
    return { data: parsed };
  } catch (_) {
    return { error: "Invalid JSON body", status: 400 };
  }
}

function safeJsonParse(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
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

export class Gta3RelayHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.rooms = new Map();

    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        user_id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        username_lower TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS campaigns (
        campaign_id TEXT PRIMARY KEY,
        host_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        world_state_json TEXT NOT NULL,
        save_blob_gz_b64 TEXT NOT NULL,
        save_rev INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaigns_host ON campaigns(host_user_id);
      CREATE TABLE IF NOT EXISTS campaign_slots (
        campaign_id TEXT NOT NULL,
        slot_idx INTEGER NOT NULL,
        user_id TEXT,
        character_name TEXT NOT NULL,
        skin_id INTEGER NOT NULL DEFAULT 0,
        money INTEGER NOT NULL DEFAULT 0,
        health REAL NOT NULL DEFAULT 100.0,
        armor REAL NOT NULL DEFAULT 0.0,
        weapons_json TEXT NOT NULL DEFAULT '[]',
        pos_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, slot_idx)
      );
      CREATE INDEX IF NOT EXISTS idx_slots_user ON campaign_slots(user_id);
    `);
  }

  allocateRoomPort(requestedPort) {
    let p = requestedPort >= MIN_ROOM_PORT && requestedPort <= MAX_ROOM_PORT ? requestedPort : DEFAULT_ROOM_PORT;
    let attempts = 0;
    while (this.rooms.has(p) && attempts < 65536) {
      p++;
      if (p > MAX_ROOM_PORT) p = MIN_ROOM_PORT;
      attempts++;
    }
    return p;
  }

  buildPlayersSnapshot(room, incomingPlayers) {
    const incomingBySlot = new Map();
    if (Array.isArray(incomingPlayers)) {
      for (const item of incomingPlayers) {
        if (!item || typeof item !== "object") continue;
        const slot = clampInt(item.slot, 1, 4, 0);
        if (slot >= 1 && slot <= 4) {
          incomingBySlot.set(slot, item);
        }
      }
    }

    const existingBySlot = new Map();
    if (Array.isArray(room.info?.players)) {
      for (const item of room.info.players) {
        if (item && typeof item === "object") {
          existingBySlot.set(item.slot, item);
        }
      }
    }

    const hostMeta = incomingBySlot.get(1) || existingBySlot.get(1);
    const list = [
      {
        slot: 1,
        name: sanitizeText(hostMeta?.name, 24, room.info.host_name || "Claude"),
        skinId: clampInt(hostMeta?.skinId, 0, 64, 0),
      },
    ];

    for (const peerId of [2, 3, 4]) {
      const client = room.clients.get(peerId);
      if (!client) continue;
      const meta = incomingBySlot.get(peerId) || existingBySlot.get(peerId);
      list.push({
        slot: peerId,
        name: sanitizeText(meta?.name, 24, client.name),
        skinId: clampInt(meta?.skinId, 0, 64, client.skinId || 0),
      });
    }
    return list;
  }

  refreshRoomInfo(room, patch = null) {
    const base = room.info || {};
    const hostName = patch?.host_name !== undefined
      ? sanitizeText(patch.host_name, 24, base.host_name || "Claude")
      : base.host_name || "Claude";
    const roomName = patch?.room_name !== undefined
      ? sanitizeText(patch.room_name, 48, base.room_name || `Liberty City #${room.port}`)
      : base.room_name || `Liberty City #${room.port}`;
    const mode = patch?.mode !== undefined ? sanitizeMode(patch.mode) : sanitizeMode(base.mode);
    const memberLimit = patch?.member_limit !== undefined
      ? clampInt(patch.member_limit, 1, 4, 4)
      : clampInt(base.member_limit, 1, 4, 4);
    const islandUnlocked = patch?.island_unlocked !== undefined
      ? clampInt(patch.island_unlocked, 1, 3, 1)
      : clampInt(base.island_unlocked, 1, 3, 1);

    const playerCount = 1 + room.clients.size;
    const players = this.buildPlayersSnapshot(room, patch?.players);
    const joinable = patch?.joinable !== undefined
      ? Boolean(patch.joinable) && playerCount < memberLimit
      : playerCount < memberLimit;

    room.info = {
      room_name: roomName,
      host_name: hostName,
      mode,
      player_count: playerCount,
      member_limit: memberLimit,
      island_unlocked: islandUnlocked,
      players,
      game_port: room.port,
      joinable,
      created_at: room.createdAt,
    };
    return room.info;
  }

  getRoomListSnapshot() {
    const list = [];
    for (const [port, room] of this.rooms.entries()) {
      if (!room.hostWs || !room.hostWs._isOpen) {
        this.rooms.delete(port);
        continue;
      }
      list.push(this.refreshRoomInfo(room));
    }
    list.sort((a, b) => b.created_at - a.created_at);
    return list;
  }

  safeSend(ws, data) {
    if (!ws || !ws._isOpen) return;
    try {
      ws.send(data);
    } catch (_) {
      // Ignore closed/closing socket errors
    }
  }

  broadcastRoomInfo(room) {
    const info = this.refreshRoomInfo(room);
    if (room.hostWs && room.hostWs._isOpen) {
      this.safeSend(
        room.hostWs,
        makeFrame(FRAME_ROOM_INFO, 1, 0, utf8Encoder.encode(JSON.stringify({ ...info, yourPeerId: 1 })))
      );
    }
    for (const [peerId, client] of room.clients.entries()) {
      this.safeSend(
        client.ws,
        makeFrame(
          FRAME_ROOM_INFO,
          peerId,
          0,
          utf8Encoder.encode(JSON.stringify({ ...info, yourPeerId: peerId }))
        )
      );
    }
  }

  broadcastToRoomOthers(room, senderPeerId, frameBytes) {
    if (senderPeerId !== 1 && room.hostWs && room.hostWs._isOpen) {
      this.safeSend(room.hostWs, frameBytes);
    }
    for (const [peerId, client] of room.clients.entries()) {
      if (peerId !== senderPeerId) {
        this.safeSend(client.ws, frameBytes);
      }
    }
  }

  routePeerFrame(room, senderPeerId, frameType, targetPeer, channel, payload) {
    const outFrame = makeFrame(frameType, senderPeerId, channel, payload);
    if (targetPeer === 0) {
      this.broadcastToRoomOthers(room, senderPeerId, outFrame);
    } else if (targetPeer === 1) {
      if (senderPeerId !== 1 && room.hostWs && room.hostWs._isOpen) {
        this.safeSend(room.hostWs, outFrame);
      }
    } else if (targetPeer >= 2 && targetPeer !== senderPeerId) {
      const targetClient = room.clients.get(targetPeer);
      if (targetClient) {
        this.safeSend(targetClient.ws, outFrame);
      }
    }
  }

  handleSocket(ws, url) {
    const role = (url.searchParams.get("role") || "client").toLowerCase();
    const requestedRoom = parseRoomPort(url.searchParams.get("room"), DEFAULT_ROOM_PORT);

    if (role === "discover") {
      const sendRooms = () => {
        this.safeSend(ws, JSON.stringify({ rooms: this.getRoomListSnapshot() }));
      };
      sendRooms();
      ws.addEventListener("message", () => sendRooms());
      return;
    }

    if (role === "host") {
      let roomPort = requestedRoom;
      const existing = this.rooms.get(roomPort);
      if (existing && existing.hostWs && existing.hostWs._isOpen) {
        roomPort = this.allocateRoomPort(requestedRoom);
      }

      const hostName = sanitizeText(url.searchParams.get("name"), 24, "Claude");
      const roomName = sanitizeText(url.searchParams.get("room_name"), 48, `${hostName}'s Liberty City`);
      const mode = sanitizeMode(url.searchParams.get("mode"));

      const room = {
        port: roomPort,
        hostWs: ws,
        clients: new Map(),
        createdAt: Date.now(),
        info: {
          room_name: roomName,
          host_name: hostName,
          mode,
          player_count: 1,
          member_limit: 4,
          island_unlocked: 1,
          players: [{ slot: 1, name: hostName, skinId: clampInt(url.searchParams.get("skinId"), 0, 64, 0) }],
          game_port: roomPort,
          joinable: true,
        },
      };
      this.rooms.set(roomPort, room);

      this.safeSend(
        ws,
        makeFrame(
          FRAME_HOST_ASSIGNED,
          roomPort,
          1,
          utf8Encoder.encode(JSON.stringify({ peerId: 1, roomPort, maxPlayers: 4 }))
        )
      );
      this.broadcastRoomInfo(room);

      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          const parsed = safeJsonParse(ev.data, null);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            this.refreshRoomInfo(room, parsed);
            this.broadcastRoomInfo(room);
          }
          return;
        }
        const buf = new Uint8Array(ev.data);
        if (buf.byteLength < 4) return;
        const frameType = buf[0];
        const targetPeer = (buf[1] << 8) | buf[2];
        const channel = buf[3];
        const payload = buf.subarray(4);

        if (frameType === FRAME_ROOM_INFO) {
          const parsed = safeJsonParse(utf8Decoder.decode(payload), null);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            this.refreshRoomInfo(room, parsed);
            this.broadcastRoomInfo(room);
          }
          return;
        }

        if (frameType === FRAME_KICK_PEER) {
          const client = room.clients.get(targetPeer);
          if (client) {
            room.clients.delete(targetPeer);
            this.safeSend(client.ws, makeFrame(FRAME_REJECTED, 1, 0, utf8Encoder.encode("Kicked by host")));
            try {
              client.ws.close(4001, "Kicked by host");
            } catch (_) {}
            this.safeSend(ws, makeFrame(FRAME_PEER_DISCONNECTED, targetPeer, 0));
            for (const other of room.clients.values()) {
              this.safeSend(other.ws, makeFrame(FRAME_PEER_DISCONNECTED, targetPeer, 0));
            }
            this.broadcastRoomInfo(room);
          }
          return;
        }

        if (frameType === FRAME_DATA || frameType === FRAME_WEBRTC_SIGNAL) {
          this.routePeerFrame(room, 1, frameType, targetPeer, channel, payload);
        }
      });

      const onHostClose = () => {
        ws._isOpen = false;
        if (this.rooms.get(roomPort) !== room) return;
        this.rooms.delete(roomPort);
        const discFrame = makeFrame(FRAME_PEER_DISCONNECTED, 1, 0);
        for (const client of room.clients.values()) {
          this.safeSend(client.ws, discFrame);
          try {
            client.ws.close(4000, "Host disconnected");
          } catch (_) {}
        }
        room.clients.clear();
      };
      ws.addEventListener("close", onHostClose);
      ws.addEventListener("error", onHostClose);
      return;
    }

    // Client role
    const room = this.rooms.get(requestedRoom);
    if (!room || !room.hostWs || !room.hostWs._isOpen) {
      this.safeSend(ws, makeFrame(FRAME_REJECTED, 0, 0, utf8Encoder.encode("Room not found or host offline")));
      try {
        ws.close(4004, "Room not found");
      } catch (_) {}
      return;
    }

    const memberLimit = clampInt(room.info?.member_limit, 1, 4, 4);
    if (room.clients.size >= MAX_CLIENTS_PER_ROOM || 1 + room.clients.size >= memberLimit) {
      this.safeSend(ws, makeFrame(FRAME_REJECTED, 0, 0, utf8Encoder.encode("Room is full (4/4)")));
      try {
        ws.close(4003, "Room full");
      } catch (_) {}
      return;
    }

    let assignedPeerId = 0;
    for (const candidate of [2, 3, 4]) {
      if (!room.clients.has(candidate)) {
        assignedPeerId = candidate;
        break;
      }
    }
    if (!assignedPeerId) {
      this.safeSend(ws, makeFrame(FRAME_REJECTED, 0, 0, utf8Encoder.encode("Room is full (4/4)")));
      try {
        ws.close(4003, "Room full");
      } catch (_) {}
      return;
    }

    const clientName = sanitizeText(url.searchParams.get("name"), 24, `Player ${assignedPeerId}`);
    const skinId = clampInt(url.searchParams.get("skinId"), 0, 64, 0);
    room.clients.set(assignedPeerId, { ws, name: clientName, skinId });

    // Notify joining client of host (peer 1) and existing peers; channel carries client's own peerId
    this.safeSend(
      ws,
      makeFrame(
        FRAME_PEER_CONNECTED,
        1,
        assignedPeerId,
        utf8Encoder.encode(
          JSON.stringify({ peerId: 1, yourPeerId: assignedPeerId, name: room.info.host_name })
        )
      )
    );
    for (const [otherId, otherClient] of room.clients.entries()) {
      if (otherId === assignedPeerId) continue;
      this.safeSend(
        ws,
        makeFrame(
          FRAME_PEER_CONNECTED,
          otherId,
          assignedPeerId,
          utf8Encoder.encode(
            JSON.stringify({ peerId: otherId, yourPeerId: assignedPeerId, name: otherClient.name })
          )
        )
      );
    }

    // Notify host and existing clients about the new peer
    const joinNotice = makeFrame(
      FRAME_PEER_CONNECTED,
      assignedPeerId,
      0,
      utf8Encoder.encode(JSON.stringify({ peerId: assignedPeerId, name: clientName, skinId }))
    );
    this.safeSend(room.hostWs, joinNotice);
    for (const [otherId, otherClient] of room.clients.entries()) {
      if (otherId !== assignedPeerId) {
        this.safeSend(otherClient.ws, joinNotice);
      }
    }
    this.broadcastRoomInfo(room);

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") return;
      const buf = new Uint8Array(ev.data);
      if (buf.byteLength < 4) return;
      const frameType = buf[0];
      const targetPeer = (buf[1] << 8) | buf[2];
      const channel = buf[3];
      const payload = buf.subarray(4);

      if (frameType === FRAME_DATA || frameType === FRAME_WEBRTC_SIGNAL) {
        this.routePeerFrame(room, assignedPeerId, frameType, targetPeer, channel, payload);
      }
    });

    const onClientClose = () => {
      ws._isOpen = false;
      const current = room.clients.get(assignedPeerId);
      if (!current || current.ws !== ws) return;
      room.clients.delete(assignedPeerId);
      const discNotice = makeFrame(FRAME_PEER_DISCONNECTED, assignedPeerId, 0);
      this.safeSend(room.hostWs, discNotice);
      for (const other of room.clients.values()) {
        this.safeSend(other.ws, discNotice);
      }
      if (room.hostWs && room.hostWs._isOpen) {
        this.broadcastRoomInfo(room);
      }
    };
    ws.addEventListener("close", onClientClose);
    ws.addEventListener("error", onClientClose);
  }

  getBearerToken(request) {
    const auth = request.headers.get("Authorization") || "";
    const match = /^Bearer\s+([^\s]+)$/i.exec(auth.trim());
    return match ? match[1] : null;
  }

  authenticateRequest(request) {
    const token = this.getBearerToken(request);
    if (!token) return null;
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT a.user_id, a.username, a.created_at, s.expires_at
         FROM sessions s
         JOIN accounts a ON a.user_id = s.user_id
         WHERE s.token = ?`,
        token
      )
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.expires_at <= now) {
      this.sql.exec("DELETE FROM sessions WHERE token = ?", token);
      return null;
    }
    return {
      token,
      userId: row.user_id,
      username: row.username,
      createdAt: row.created_at,
    };
  }

  createSession(userId) {
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    const token = generateHexToken(32);
    const expiresAt = now + SESSION_TTL_MS;
    this.sql.exec(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
      token,
      userId,
      expiresAt
    );
    return { token, expiresAt };
  }

  async handleRegister(request) {
    const body = await readJsonBody(request);
    if (body.error) return jsonResponse({ ok: false, error: body.error }, body.status);

    const rawUsername = String(body.data.username ?? "").trim();
    const password = String(body.data.password ?? "");
    if (!/^[a-zA-Z0-9_.\- ]{3,24}$/.test(rawUsername)) {
      return jsonResponse(
        { ok: false, error: "Username must be 3-24 characters (letters, numbers, _, ., -, space)" },
        400
      );
    }
    if (password.length < 4 || password.length > 128) {
      return jsonResponse({ ok: false, error: "Password must be 4-128 characters" }, 400);
    }

    const usernameLower = rawUsername.toLowerCase();
    const existing = this.sql
      .exec("SELECT user_id FROM accounts WHERE username_lower = ?", usernameLower)
      .toArray();
    if (existing.length > 0) {
      return jsonResponse({ ok: false, error: "Username already taken" }, 409);
    }

    const userId = crypto.randomUUID();
    const salt = generateHexToken(16);
    const hash = await hashPassword(password, salt);
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO accounts (user_id, username, username_lower, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      userId,
      rawUsername,
      usernameLower,
      hash,
      salt,
      now
    );

    const session = this.createSession(userId);
    return jsonResponse(
      {
        ok: true,
        token: session.token,
        expiresAt: session.expiresAt,
        user: { userId, username: rawUsername, createdAt: now },
      },
      201
    );
  }

  async handleLogin(request) {
    const body = await readJsonBody(request);
    if (body.error) return jsonResponse({ ok: false, error: body.error }, body.status);

    const usernameLower = String(body.data.username ?? "").trim().toLowerCase();
    const password = String(body.data.password ?? "");
    if (!usernameLower || !password) {
      return jsonResponse({ ok: false, error: "Username and password required" }, 400);
    }

    const rows = this.sql
      .exec(
        "SELECT user_id, username, password_hash, password_salt, created_at FROM accounts WHERE username_lower = ?",
        usernameLower
      )
      .toArray();
    if (rows.length === 0) {
      return jsonResponse({ ok: false, error: "Invalid username or password" }, 401);
    }

    const acc = rows[0];
    const hash = await hashPassword(password, acc.password_salt);
    if (!timingSafeEqualHex(hash, acc.password_hash)) {
      return jsonResponse({ ok: false, error: "Invalid username or password" }, 401);
    }

    const session = this.createSession(acc.user_id);
    return jsonResponse({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: { userId: acc.user_id, username: acc.username, createdAt: acc.created_at },
    });
  }

  handleLogout(request) {
    const token = this.getBearerToken(request);
    if (token) {
      this.sql.exec("DELETE FROM sessions WHERE token = ?", token);
    }
    return jsonResponse({ ok: true });
  }

  handleMe(request) {
    const user = this.authenticateRequest(request);
    if (!user) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    return jsonResponse({
      ok: true,
      user: { userId: user.userId, username: user.username, createdAt: user.createdAt },
    });
  }

  formatSlotRow(row) {
    return {
      campaign_id: row.campaign_id,
      slot_idx: row.slot_idx,
      user_id: row.user_id,
      character_name: row.character_name,
      skin_id: row.skin_id,
      money: row.money,
      health: row.health,
      armor: row.armor,
      weapons_json: row.weapons_json,
      pos_json: row.pos_json,
      updated_at: row.updated_at,
    };
  }

  handleListCampaigns(request) {
    const user = this.authenticateRequest(request);
    if (!user) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

    const rows = this.sql
      .exec(
        `SELECT DISTINCT c.campaign_id, c.host_user_id, c.title, c.mode, c.world_state_json,
                length(c.save_blob_gz_b64) AS save_blob_len, c.save_rev, c.updated_at, c.created_at
         FROM campaigns c
         LEFT JOIN campaign_slots s ON s.campaign_id = c.campaign_id
         WHERE c.host_user_id = ? OR s.user_id = ?
         ORDER BY c.updated_at DESC`,
        user.userId,
        user.userId
      )
      .toArray();

    const campaigns = rows.map((r) => {
      const slotRows = this.sql
        .exec("SELECT * FROM campaign_slots WHERE campaign_id = ? ORDER BY slot_idx ASC", r.campaign_id)
        .toArray();
      return {
        campaign_id: r.campaign_id,
        host_user_id: r.host_user_id,
        title: r.title,
        mode: r.mode,
        world_state_json: r.world_state_json,
        world_state: safeJsonParse(r.world_state_json, {}),
        save_blob_len: r.save_blob_len || 0,
        save_rev: r.save_rev,
        updated_at: r.updated_at,
        created_at: r.created_at,
        slots: slotRows.map((s) => this.formatSlotRow(s)),
      };
    });

    return jsonResponse({ ok: true, campaigns });
  }

  async handleSaveCampaign(request) {
    const user = this.authenticateRequest(request);
    if (!user) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

    const body = await readJsonBody(request);
    if (body.error) return jsonResponse({ ok: false, error: body.error }, body.status);
    const data = body.data;

    const requestedId = String(data.campaign_id ?? data.campaignId ?? "").trim();
    const campaignId = requestedId || crypto.randomUUID();
    if (campaignId.length > 80) {
      return jsonResponse({ ok: false, error: "Invalid campaign_id" }, 400);
    }

    const existingRows = this.sql
      .exec("SELECT campaign_id, host_user_id, save_rev, created_at FROM campaigns WHERE campaign_id = ?", campaignId)
      .toArray();
    const existing = existingRows[0] || null;

    if (existing && existing.host_user_id !== user.userId) {
      return jsonResponse({ ok: false, error: "Only the campaign host can overwrite this save" }, 403);
    }

    const now = Date.now();
    const title = sanitizeText(data.title, 64, "Liberty City Co-op");
    const mode = sanitizeMode(data.mode);

    let worldStateJson = "{}";
    const rawWorldState = data.world_state_json ?? data.worldState;
    if (typeof rawWorldState === "string") {
      worldStateJson = rawWorldState;
    } else if (rawWorldState && typeof rawWorldState === "object") {
      worldStateJson = JSON.stringify(rawWorldState);
    }

    const saveBlobGzB64 = String(data.save_blob_gz_b64 ?? data.saveBlobGzB64 ?? "");
    const saveRev = existing ? existing.save_rev + 1 : 1;
    const createdAt = existing ? existing.created_at : now;

    this.sql.exec(
      `INSERT OR REPLACE INTO campaigns
       (campaign_id, host_user_id, title, mode, world_state_json, save_blob_gz_b64, save_rev, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      campaignId,
      user.userId,
      title,
      mode,
      worldStateJson,
      saveBlobGzB64,
      saveRev,
      now,
      createdAt
    );

    // Normalize and upsert all 4 campaign_slots (0..3)
    const incomingSlots = Array.isArray(data.slots) ? data.slots : [];
    const byIdx = new Map();
    for (let i = 0; i < incomingSlots.length; i++) {
      const slot = incomingSlots[i];
      if (!slot || typeof slot !== "object") continue;
      const idx = clampInt(slot.slot_idx ?? slot.slotIdx, 0, 3, i <= 3 ? i : -1);
      if (idx >= 0 && idx <= 3) {
        byIdx.set(idx, slot);
      }
    }

    const savedSlots = [];
    for (let slotIdx = 0; slotIdx < 4; slotIdx++) {
      const slot = byIdx.get(slotIdx) || {};
      const slotUserId =
        slot.user_id !== undefined
          ? slot.user_id
            ? String(slot.user_id)
            : null
          : slot.userId !== undefined
          ? slot.userId
            ? String(slot.userId)
            : null
          : slotIdx === 0
          ? user.userId
          : null;
      const characterName = sanitizeText(
        slot.character_name ?? slot.characterName,
        32,
        slotIdx === 0 ? user.username : `Player ${slotIdx + 1}`
      );
      const skinId = clampInt(slot.skin_id ?? slot.skinId, 0, 64, 0);
      const money = clampInt(slot.money, -99999999, 999999999, 0);
      const health = clampNum(slot.health, 0, 10000, 100.0);
      const armor = clampNum(slot.armor, 0, 10000, 0.0);
      const rawWeapons = slot.weapons_json ?? slot.weapons;
      const weaponsJson =
        typeof rawWeapons === "string"
          ? rawWeapons
          : JSON.stringify(Array.isArray(rawWeapons) ? rawWeapons : []);
      const rawPos = slot.pos_json ?? slot.pos;
      const posJson =
        typeof rawPos === "string"
          ? rawPos
          : JSON.stringify(rawPos && typeof rawPos === "object" ? rawPos : {});

      this.sql.exec(
        `INSERT OR REPLACE INTO campaign_slots
         (campaign_id, slot_idx, user_id, character_name, skin_id, money, health, armor, weapons_json, pos_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        campaignId,
        slotIdx,
        slotUserId,
        characterName,
        skinId,
        money,
        health,
        armor,
        weaponsJson,
        posJson,
        now
      );

      savedSlots.push({
        campaign_id: campaignId,
        slot_idx: slotIdx,
        user_id: slotUserId,
        character_name: characterName,
        skin_id: skinId,
        money,
        health,
        armor,
        weapons_json: weaponsJson,
        pos_json: posJson,
        updated_at: now,
      });
    }

    return jsonResponse({
      ok: true,
      campaign_id: campaignId,
      save_rev: saveRev,
      updated_at: now,
      created_at: createdAt,
      slots: savedSlots,
    });
  }

  handleLoadCampaign(request, campaignId) {
    const user = this.authenticateRequest(request);
    if (!user) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

    const rows = this.sql.exec("SELECT * FROM campaigns WHERE campaign_id = ?", campaignId).toArray();
    if (rows.length === 0) {
      return jsonResponse({ ok: false, error: "Campaign not found" }, 404);
    }
    const camp = rows[0];
    const slotRows = this.sql
      .exec("SELECT * FROM campaign_slots WHERE campaign_id = ? ORDER BY slot_idx ASC", campaignId)
      .toArray();

    const isMember =
      camp.host_user_id === user.userId || slotRows.some((s) => s.user_id && s.user_id === user.userId);
    if (!isMember) {
      return jsonResponse({ ok: false, error: "Forbidden" }, 403);
    }

    const slots = slotRows.map((s) => this.formatSlotRow(s));
    return jsonResponse({
      ok: true,
      campaign_id: camp.campaign_id,
      host_user_id: camp.host_user_id,
      title: camp.title,
      mode: camp.mode,
      world_state_json: camp.world_state_json,
      world_state: safeJsonParse(camp.world_state_json, {}),
      save_blob_gz_b64: camp.save_blob_gz_b64,
      save_rev: camp.save_rev,
      updated_at: camp.updated_at,
      created_at: camp.created_at,
      slots,
    });
  }

  handleDeleteCampaign(request, campaignId) {
    const user = this.authenticateRequest(request);
    if (!user) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

    const rows = this.sql
      .exec("SELECT campaign_id, host_user_id FROM campaigns WHERE campaign_id = ?", campaignId)
      .toArray();
    if (rows.length === 0) {
      return jsonResponse({ ok: false, error: "Campaign not found" }, 404);
    }
    if (rows[0].host_user_id !== user.userId) {
      return jsonResponse({ ok: false, error: "Only the campaign host can delete this campaign" }, 403);
    }

    this.sql.exec("DELETE FROM campaign_slots WHERE campaign_id = ?", campaignId);
    this.sql.exec("DELETE FROM campaigns WHERE campaign_id = ?", campaignId);
    return jsonResponse({ ok: true, deleted: true, campaign_id: campaignId });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [clientSocket, serverSocket] = Object.values(pair);
      serverSocket.accept();
      serverSocket._isOpen = true;
      this.handleSocket(serverSocket, url);
      return new Response(null, { status: 101, webSocket: clientSocket });
    }

    if (pathname === "/api/info" && request.method === "GET") {
      const rooms = this.getRoomListSnapshot();
      return jsonResponse({
        ok: true,
        mode: "cloudflare-durable-object",
        activeRooms: rooms.length,
        defaultRoomPort: DEFAULT_ROOM_PORT,
        maxPlayersPerRoom: 4,
        rooms,
      });
    }

    if (pathname === "/api/rooms" && request.method === "GET") {
      return jsonResponse({ ok: true, rooms: this.getRoomListSnapshot() });
    }

    if (pathname === "/api/auth/register" && request.method === "POST") {
      return this.handleRegister(request);
    }
    if (pathname === "/api/auth/login" && request.method === "POST") {
      return this.handleLogin(request);
    }
    if (pathname === "/api/auth/logout" && request.method === "POST") {
      return this.handleLogout(request);
    }
    if (pathname === "/api/auth/me" && request.method === "GET") {
      return this.handleMe(request);
    }

    if (pathname === "/api/campaigns" && request.method === "GET") {
      return this.handleListCampaigns(request);
    }
    if (pathname === "/api/campaigns/save" && request.method === "POST") {
      return this.handleSaveCampaign(request);
    }

    const loadMatch = /^\/api\/campaigns\/([^/]+)\/load$/.exec(pathname);
    if (loadMatch && request.method === "GET") {
      return this.handleLoadCampaign(request, decodeURIComponent(loadMatch[1]));
    }

    const delMatch = /^\/api\/campaigns\/([^/]+)$/.exec(pathname);
    if (delMatch && request.method === "DELETE") {
      const campaignId = decodeURIComponent(delMatch[1]);
      if (campaignId !== "save") {
        return this.handleDeleteCampaign(request, campaignId);
      }
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  }
}
