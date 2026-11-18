#!/usr/bin/env node
/**
 * GTA III Web — Local Zero-Dependency HTTP, WebSocket Relay & Persistence Server
 * ==============================================================================
 * Mirrors the exact REST API, PBKDF2 auth, campaign persistence, static Range
 * serving, and binary WebSocket + WebRTC signaling protocol of `cloudflare_worker.js`
 * (`Gta3RelayHub`) with zero external npm dependencies.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const PUBLIC_DIR = path.resolve(__dirname, "public");
const DATA_DIR = path.resolve(__dirname, ".local_data");
const DATA_STORE_PATH = path.join(DATA_DIR, "data_store.json");

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
const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const VALID_MODES = new Set(["story_coop", "open_sandbox"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
};

/**
 * Lightweight RFC 6455 WebSocket wrapper over Node.js net.Socket.
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
    socket.on("close", () => this._emitClose());
    socket.on("error", () => this._emitClose());
  }

  get isOpen() {
    return !this.closed && this.socket.writable;
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
        const bigLen = this.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_WS_PAYLOAD_BYTES)) {
          this.close(1009, "Message too big");
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_WS_PAYLOAD_BYTES) {
        this.close(1009, "Message too big");
        return;
      }

      const maskLen = masked ? 4 : 0;
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
        this.close();
        return;
      } else if (opcode === 0x09) {
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
          const isBinary = this.fragmentOpcode === 0x02;
          this.fragments = [];
          if (this.onMessage) {
            this.onMessage(fullPayload, isBinary);
          }
        }
      }
    }
  }

  _sendFrame(opcode, dataBuffer) {
    if (!this.isOpen) return;
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

  send(data) {
    if (typeof data === "string") {
      this._sendFrame(0x01, Buffer.from(data, "utf-8"));
      return;
    }
    const buf = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this._sendFrame(0x02, buf);
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    try {
      const reasonBuf = Buffer.from(String(reason || ""), "utf-8").subarray(0, 120);
      const closePayload = Buffer.alloc(2 + reasonBuf.length);
      closePayload.writeUInt16BE(code, 0);
      reasonBuf.copy(closePayload, 2);
      this._sendFrame(0x08, closePayload);
      this.socket.end();
    } catch (_) {}
    this._emitClose();
  }
}

// ----------------------------------------------------------------------------
// Local JSON File Persistence (.local_data/data_store.json)
// ----------------------------------------------------------------------------
function loadStore() {
  try {
    if (fs.existsSync(DATA_STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_STORE_PATH, "utf-8"));
      return {
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : [],
        campaign_slots: Array.isArray(parsed.campaign_slots) ? parsed.campaign_slots : [],
      };
    }
  } catch (err) {
    console.warn("[STORE] Failed to load data_store.json, starting fresh:", err.message);
  }
  return { accounts: [], sessions: [], campaigns: [], campaign_slots: [] };
}

let db = loadStore();

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = DATA_STORE_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), "utf-8");
  fs.renameSync(tmpPath, DATA_STORE_PATH);
}

// ----------------------------------------------------------------------------
// Helpers (shared semantics with cloudflare_worker.js)
// ----------------------------------------------------------------------------
function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal && !iface.address.startsWith("169.254.")) {
        results.push(iface.address);
      }
    }
  }
  results.sort((a, b) => {
    const score = (ip) =>
      ip.startsWith("192.168.1.") ? 0 : ip.startsWith("192.168.") ? 1 : ip.startsWith("10.") ? 2 : 3;
    return score(a) - score(b);
  });
  return results;
}

function makeFrame(type, peerId, channel, payloadBuf) {
  const payload = payloadBuf ? Buffer.from(payloadBuf) : Buffer.alloc(0);
  const out = Buffer.allocUnsafe(4 + payload.length);
  out[0] = type & 0xff;
  out[1] = (peerId >> 8) & 0xff;
  out[2] = peerId & 0xff;
  out[3] = channel & 0xff;
  if (payload.length > 0) {
    payload.copy(out, 4);
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

function safeJsonParse(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function hashPassword(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      Buffer.from(saltHex, "hex"),
      PBKDF2_ITERATIONS,
      32,
      "sha256",
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived.toString("hex"));
      }
    );
  });
}

function timingSafeEqualHex(aHex, bHex) {
  if (typeof aHex !== "string" || typeof bHex !== "string" || aHex.length !== bHex.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(aHex, "hex"), Buffer.from(bHex, "hex"));
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        settled = true;
        resolve({ error: "Payload too large", status: 413 });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf-8");
      try {
        const parsed = text ? JSON.parse(text) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          resolve({ error: "JSON body must be an object", status: 400 });
          return;
        }
        resolve({ data: parsed });
      } catch (_) {
        resolve({ error: "Invalid JSON body", status: 400 });
      }
    });
    req.on("error", () => {
      if (!settled) {
        settled = true;
        resolve({ error: "Failed to read request body", status: 400 });
      }
    });
  });
}

// ----------------------------------------------------------------------------
// Auth & Campaign REST Handlers
// ----------------------------------------------------------------------------
function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(auth).trim());
  return match ? match[1] : null;
}

function authenticateRequest(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const now = Date.now();
  const idx = db.sessions.findIndex((s) => s.token === token);
  if (idx === -1) return null;
  const session = db.sessions[idx];
  if (session.expires_at <= now) {
    db.sessions.splice(idx, 1);
    saveStore();
    return null;
  }
  const account = db.accounts.find((a) => a.user_id === session.user_id);
  if (!account) return null;
  return {
    token,
    userId: account.user_id,
    username: account.username,
    createdAt: account.created_at,
  };
}

function createSession(userId) {
  const now = Date.now();
  db.sessions = db.sessions.filter((s) => s.expires_at > now);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = now + SESSION_TTL_MS;
  db.sessions.push({ token, user_id: userId, expires_at: expiresAt });
  saveStore();
  return { token, expiresAt };
}

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  if (body.error) return sendJson(res, { ok: false, error: body.error }, body.status);

  const rawUsername = String(body.data.username ?? "").trim();
  const password = String(body.data.password ?? "");
  if (!/^[a-zA-Z0-9_.\- ]{3,24}$/.test(rawUsername)) {
    return sendJson(
      res,
      { ok: false, error: "Username must be 3-24 characters (letters, numbers, _, ., -, space)" },
      400
    );
  }
  if (password.length < 4 || password.length > 128) {
    return sendJson(res, { ok: false, error: "Password must be 4-128 characters" }, 400);
  }

  const usernameLower = rawUsername.toLowerCase();
  if (db.accounts.some((a) => a.username_lower === usernameLower)) {
    return sendJson(res, { ok: false, error: "Username already taken" }, 409);
  }

  const userId = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);
  const now = Date.now();

  db.accounts.push({
    user_id: userId,
    username: rawUsername,
    username_lower: usernameLower,
    password_hash: hash,
    password_salt: salt,
    created_at: now,
  });

  const session = createSession(userId);
  return sendJson(
    res,
    {
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: { userId, username: rawUsername, createdAt: now },
    },
    201
  );
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  if (body.error) return sendJson(res, { ok: false, error: body.error }, body.status);

  const usernameLower = String(body.data.username ?? "").trim().toLowerCase();
  const password = String(body.data.password ?? "");
  if (!usernameLower || !password) {
    return sendJson(res, { ok: false, error: "Username and password required" }, 400);
  }

  const acc = db.accounts.find((a) => a.username_lower === usernameLower);
  if (!acc) {
    return sendJson(res, { ok: false, error: "Invalid username or password" }, 401);
  }

  const hash = await hashPassword(password, acc.password_salt);
  if (!timingSafeEqualHex(hash, acc.password_hash)) {
    return sendJson(res, { ok: false, error: "Invalid username or password" }, 401);
  }

  const session = createSession(acc.user_id);
  return sendJson(res, {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: { userId: acc.user_id, username: acc.username, createdAt: acc.created_at },
  });
}

function handleLogout(req, res) {
  const token = getBearerToken(req);
  if (token) {
    db.sessions = db.sessions.filter((s) => s.token !== token);
    saveStore();
  }
  return sendJson(res, { ok: true });
}

function handleMe(req, res) {
  const user = authenticateRequest(req);
  if (!user) return sendJson(res, { ok: false, error: "Unauthorized" }, 401);
  return sendJson(res, {
    ok: true,
    user: { userId: user.userId, username: user.username, createdAt: user.createdAt },
  });
}

function getCampaignSlots(campaignId) {
  return db.campaign_slots
    .filter((s) => s.campaign_id === campaignId)
    .sort((a, b) => a.slot_idx - b.slot_idx);
}

function handleListCampaigns(req, res) {
  const user = authenticateRequest(req);
  if (!user) return sendJson(res, { ok: false, error: "Unauthorized" }, 401);

  const memberCampaignIds = new Set(
    db.campaign_slots.filter((s) => s.user_id === user.userId).map((s) => s.campaign_id)
  );
  const matching = db.campaigns
    .filter((c) => c.host_user_id === user.userId || memberCampaignIds.has(c.campaign_id))
    .sort((a, b) => b.updated_at - a.updated_at);

  const campaigns = matching.map((c) => ({
    campaign_id: c.campaign_id,
    host_user_id: c.host_user_id,
    title: c.title,
    mode: c.mode,
    world_state_json: c.world_state_json,
    world_state: safeJsonParse(c.world_state_json, {}),
    save_blob_len: (c.save_blob_gz_b64 || "").length,
    save_rev: c.save_rev,
    updated_at: c.updated_at,
    created_at: c.created_at,
    slots: getCampaignSlots(c.campaign_id),
  }));

  return sendJson(res, { ok: true, campaigns });
}

async function handleSaveCampaign(req, res) {
  const user = authenticateRequest(req);
  if (!user) return sendJson(res, { ok: false, error: "Unauthorized" }, 401);

  const body = await readJsonBody(req);
  if (body.error) return sendJson(res, { ok: false, error: body.error }, body.status);
  const data = body.data;

  const requestedId = String(data.campaign_id ?? data.campaignId ?? "").trim();
  const campaignId = requestedId || crypto.randomUUID();
  if (campaignId.length > 80) {
    return sendJson(res, { ok: false, error: "Invalid campaign_id" }, 400);
  }

  const existingIdx = db.campaigns.findIndex((c) => c.campaign_id === campaignId);
  const existing = existingIdx !== -1 ? db.campaigns[existingIdx] : null;
  if (existing && existing.host_user_id !== user.userId) {
    return sendJson(res, { ok: false, error: "Only the campaign host can overwrite this save" }, 403);
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

  const campaignRecord = {
    campaign_id: campaignId,
    host_user_id: user.userId,
    title,
    mode,
    world_state_json: worldStateJson,
    save_blob_gz_b64: saveBlobGzB64,
    save_rev: saveRev,
    updated_at: now,
    created_at: createdAt,
  };
  if (existingIdx !== -1) {
    db.campaigns[existingIdx] = campaignRecord;
  } else {
    db.campaigns.push(campaignRecord);
  }

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

  db.campaign_slots = db.campaign_slots.filter((s) => s.campaign_id !== campaignId);
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

    const slotRecord = {
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
    };
    db.campaign_slots.push(slotRecord);
    savedSlots.push(slotRecord);
  }

  saveStore();
  return sendJson(res, {
    ok: true,
    campaign_id: campaignId,
    save_rev: saveRev,
    updated_at: now,
    created_at: createdAt,
    slots: savedSlots,
  });
}

function handleLoadCampaign(req, res, campaignId) {
  const user = authenticateRequest(req);
  if (!user) return sendJson(res, { ok: false, error: "Unauthorized" }, 401);

  const camp = db.campaigns.find((c) => c.campaign_id === campaignId);
  if (!camp) return sendJson(res, { ok: false, error: "Campaign not found" }, 404);

  const slots = getCampaignSlots(campaignId);
  const isMember =
    camp.host_user_id === user.userId || slots.some((s) => s.user_id && s.user_id === user.userId);
  if (!isMember) return sendJson(res, { ok: false, error: "Forbidden" }, 403);

  return sendJson(res, {
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

function handleDeleteCampaign(req, res, campaignId) {
  const user = authenticateRequest(req);
  if (!user) return sendJson(res, { ok: false, error: "Unauthorized" }, 401);

  const camp = db.campaigns.find((c) => c.campaign_id === campaignId);
  if (!camp) return sendJson(res, { ok: false, error: "Campaign not found" }, 404);
  if (camp.host_user_id !== user.userId) {
    return sendJson(res, { ok: false, error: "Only the campaign host can delete this campaign" }, 403);
  }

  db.campaigns = db.campaigns.filter((c) => c.campaign_id !== campaignId);
  db.campaign_slots = db.campaign_slots.filter((s) => s.campaign_id !== campaignId);
  saveStore();
  return sendJson(res, { ok: true, deleted: true, campaign_id: campaignId });
}

// ----------------------------------------------------------------------------
// Room Management & Binary WebSocket Relay
// ----------------------------------------------------------------------------
const rooms = new Map();

function allocateRoomPort(requestedPort) {
  let p = requestedPort >= MIN_ROOM_PORT && requestedPort <= MAX_ROOM_PORT ? requestedPort : DEFAULT_ROOM_PORT;
  let attempts = 0;
  while (rooms.has(p) && attempts < 65536) {
    p++;
    if (p > MAX_ROOM_PORT) p = MIN_ROOM_PORT;
    attempts++;
  }
  return p;
}

function buildPlayersSnapshot(room, incomingPlayers) {
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

function refreshRoomInfo(room, patch = null) {
  const base = room.info || {};
  const hostName =
    patch?.host_name !== undefined
      ? sanitizeText(patch.host_name, 24, base.host_name || "Claude")
      : base.host_name || "Claude";
  const roomName =
    patch?.room_name !== undefined
      ? sanitizeText(patch.room_name, 48, base.room_name || `Liberty City #${room.port}`)
      : base.room_name || `Liberty City #${room.port}`;
  const mode = patch?.mode !== undefined ? sanitizeMode(patch.mode) : sanitizeMode(base.mode);
  const memberLimit =
    patch?.member_limit !== undefined
      ? clampInt(patch.member_limit, 1, 4, 4)
      : clampInt(base.member_limit, 1, 4, 4);
  const islandUnlocked =
    patch?.island_unlocked !== undefined
      ? clampInt(patch.island_unlocked, 1, 3, 1)
      : clampInt(base.island_unlocked, 1, 3, 1);

  const playerCount = 1 + room.clients.size;
  const players = buildPlayersSnapshot(room, patch?.players);
  const joinable =
    patch?.joinable !== undefined ? Boolean(patch.joinable) && playerCount < memberLimit : playerCount < memberLimit;

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

function getRoomListSnapshot() {
  const list = [];
  for (const [port, room] of rooms.entries()) {
    if (!room.hostWs || !room.hostWs.isOpen) {
      rooms.delete(port);
      continue;
    }
    list.push(refreshRoomInfo(room));
  }
  list.sort((a, b) => b.created_at - a.created_at);
  return list;
}

function broadcastRoomInfo(room) {
  const info = refreshRoomInfo(room);
  if (room.hostWs && room.hostWs.isOpen) {
    room.hostWs.send(
      makeFrame(FRAME_ROOM_INFO, 1, 0, Buffer.from(JSON.stringify({ ...info, yourPeerId: 1 }), "utf-8"))
    );
  }
  for (const [peerId, client] of room.clients.entries()) {
    if (client.ws.isOpen) {
      client.ws.send(
        makeFrame(
          FRAME_ROOM_INFO,
          peerId,
          0,
          Buffer.from(JSON.stringify({ ...info, yourPeerId: peerId }), "utf-8")
        )
      );
    }
  }
}

function routePeerFrame(room, senderPeerId, frameType, targetPeer, channel, payload) {
  const outFrame = makeFrame(frameType, senderPeerId, channel, payload);
  if (targetPeer === 0) {
    if (senderPeerId !== 1 && room.hostWs && room.hostWs.isOpen) {
      room.hostWs.send(outFrame);
    }
    for (const [peerId, client] of room.clients.entries()) {
      if (peerId !== senderPeerId && client.ws.isOpen) {
        client.ws.send(outFrame);
      }
    }
  } else if (targetPeer === 1) {
    if (senderPeerId !== 1 && room.hostWs && room.hostWs.isOpen) {
      room.hostWs.send(outFrame);
    }
  } else if (targetPeer >= 2 && targetPeer !== senderPeerId) {
    const targetClient = room.clients.get(targetPeer);
    if (targetClient && targetClient.ws.isOpen) {
      targetClient.ws.send(outFrame);
    }
  }
}

// ----------------------------------------------------------------------------
// HTTP Server & Static Assets (with Range support)
// ----------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  if (pathname === "/api/info" && req.method === "GET") {
    const activeRooms = getRoomListSnapshot();
    return sendJson(res, {
      ok: true,
      mode: "local-node-server",
      activeRooms: activeRooms.length,
      defaultRoomPort: DEFAULT_ROOM_PORT,
      maxPlayersPerRoom: 4,
      lanIps: getLanAddresses(),
      rooms: activeRooms,
    });
  }

  if (pathname === "/api/rooms" && req.method === "GET") {
    return sendJson(res, { ok: true, rooms: getRoomListSnapshot() });
  }

  if (pathname === "/api/trace") {
    console.log("[CLIENT-TRACE]", parsedUrl.searchParams.get("m") || "");
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (pathname === "/api/auth/register" && req.method === "POST") {
    return handleRegister(req, res);
  }
  if (pathname === "/api/auth/login" && req.method === "POST") {
    return handleLogin(req, res);
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    return handleLogout(req, res);
  }
  if (pathname === "/api/auth/me" && req.method === "GET") {
    return handleMe(req, res);
  }

  if (pathname === "/api/campaigns" && req.method === "GET") {
    return handleListCampaigns(req, res);
  }
  if (pathname === "/api/campaigns/save" && req.method === "POST") {
    return handleSaveCampaign(req, res);
  }

  const loadMatch = /^\/api\/campaigns\/([^/]+)\/load$/.exec(pathname);
  if (loadMatch && req.method === "GET") {
    return handleLoadCampaign(req, res, loadMatch[1]);
  }

  const delMatch = /^\/api\/campaigns\/([^/]+)$/.exec(pathname);
  if (delMatch && req.method === "DELETE" && delMatch[1] !== "save") {
    return handleDeleteCampaign(req, res, delMatch[1]);
  }

  if (pathname.startsWith("/api/")) {
    return sendJson(res, { ok: false, error: "Not found" }, 404);
  }

  let reqPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, "." + reqPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (pathname === "/" || pathname === "/health") {
        return sendJson(res, { ok: true, service: "GTA III Web Local Server", activeRooms: rooms.size });
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const etag = `"${stat.size}-${Math.trunc(stat.mtimeMs).toString(16)}"`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("ETag", etag);
    res.setHeader(
      "Cache-Control",
      ext === ".bin" ? "public, max-age=3600" : "no-store, no-cache, must-revalidate"
    );

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
      if (match) {
        let start;
        let end;
        if (match[1] === "" && match[2] !== "") {
          const suffixLen = Number.parseInt(match[2], 10);
          start = Math.max(0, stat.size - suffixLen);
          end = stat.size - 1;
        } else {
          start = match[1] ? Number.parseInt(match[1], 10) : 0;
          end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
        }
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && end < stat.size) {
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Content-Length": end - start + 1,
          });
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
    }

    res.writeHead(200, { "Content-Length": stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ----------------------------------------------------------------------------
// WebSocket Upgrade Handler (/ws)
// ----------------------------------------------------------------------------
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (!key || (url.pathname !== "/ws" && url.pathname !== "/")) {
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
  const role = (url.searchParams.get("role") || "client").toLowerCase();
  const requestedRoom = parseRoomPort(url.searchParams.get("room"), DEFAULT_ROOM_PORT);

  if (role === "discover") {
    const sendRooms = () => {
      ws.send(JSON.stringify({ rooms: getRoomListSnapshot() }));
    };
    sendRooms();
    ws.onMessage = () => sendRooms();
    return;
  }

  if (role === "host") {
    let roomPort = requestedRoom;
    const existing = rooms.get(roomPort);
    if (existing && existing.hostWs && existing.hostWs.isOpen) {
      roomPort = allocateRoomPort(requestedRoom);
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
    rooms.set(roomPort, room);
    console.log(`[ROOM] Host created room #${roomPort} (${room.info.room_name}, active rooms: ${rooms.size})`);

    ws.send(
      makeFrame(
        FRAME_HOST_ASSIGNED,
        roomPort,
        1,
        Buffer.from(JSON.stringify({ peerId: 1, roomPort, maxPlayers: 4 }), "utf-8")
      )
    );
    broadcastRoomInfo(room);

    ws.onMessage = (buf, isBinary) => {
      if (!isBinary) {
        const parsed = safeJsonParse(buf.toString("utf-8"), null);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          refreshRoomInfo(room, parsed);
          broadcastRoomInfo(room);
        }
        return;
      }
      if (buf.length < 4) return;
      const frameType = buf[0];
      const targetPeer = (buf[1] << 8) | buf[2];
      const channel = buf[3];
      const payload = buf.subarray(4);

      if (frameType === FRAME_ROOM_INFO) {
        const parsed = safeJsonParse(Buffer.from(payload).toString("utf-8"), null);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          refreshRoomInfo(room, parsed);
          broadcastRoomInfo(room);
        }
        return;
      }

      if (frameType === FRAME_KICK_PEER) {
        const client = room.clients.get(targetPeer);
        if (client) {
          room.clients.delete(targetPeer);
          client.ws.send(makeFrame(FRAME_REJECTED, 1, 0, Buffer.from("Kicked by host", "utf-8")));
          client.ws.close(4001, "Kicked by host");
          ws.send(makeFrame(FRAME_PEER_DISCONNECTED, targetPeer, 0));
          for (const other of room.clients.values()) {
            other.ws.send(makeFrame(FRAME_PEER_DISCONNECTED, targetPeer, 0));
          }
          broadcastRoomInfo(room);
        }
        return;
      }

      if (frameType === FRAME_DATA || frameType === FRAME_WEBRTC_SIGNAL) {
        routePeerFrame(room, 1, frameType, targetPeer, channel, payload);
      }
    };

    ws.onClose = () => {
      if (rooms.get(roomPort) !== room) return;
      rooms.delete(roomPort);
      console.log(`[ROOM] Host closed room #${roomPort} (active rooms: ${rooms.size})`);
      const discFrame = makeFrame(FRAME_PEER_DISCONNECTED, 1, 0);
      for (const client of room.clients.values()) {
        client.ws.send(discFrame);
        client.ws.close(4000, "Host disconnected");
      }
      room.clients.clear();
    };
    return;
  }

  // Client role
  const room = rooms.get(requestedRoom);
  if (!room || !room.hostWs || !room.hostWs.isOpen) {
    ws.send(makeFrame(FRAME_REJECTED, 0, 0, Buffer.from("Room not found or host offline", "utf-8")));
    ws.close(4004, "Room not found");
    return;
  }

  const memberLimit = clampInt(room.info?.member_limit, 1, 4, 4);
  if (room.clients.size >= MAX_CLIENTS_PER_ROOM || 1 + room.clients.size >= memberLimit) {
    ws.send(makeFrame(FRAME_REJECTED, 0, 0, Buffer.from("Room is full (4/4)", "utf-8")));
    ws.close(4003, "Room full");
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
    ws.send(makeFrame(FRAME_REJECTED, 0, 0, Buffer.from("Room is full (4/4)", "utf-8")));
    ws.close(4003, "Room full");
    return;
  }

  const clientName = sanitizeText(url.searchParams.get("name"), 24, `Player ${assignedPeerId}`);
  const skinId = clampInt(url.searchParams.get("skinId"), 0, 64, 0);
  room.clients.set(assignedPeerId, { ws, name: clientName, skinId });
  console.log(`[ROOM] Client peer=${assignedPeerId} (${clientName}) joined #${room.port} (${1 + room.clients.size}/4)`);

  ws.send(
    makeFrame(
      FRAME_PEER_CONNECTED,
      1,
      assignedPeerId,
      Buffer.from(JSON.stringify({ peerId: 1, yourPeerId: assignedPeerId, name: room.info.host_name }), "utf-8")
    )
  );
  for (const [otherId, otherClient] of room.clients.entries()) {
    if (otherId === assignedPeerId) continue;
    ws.send(
      makeFrame(
        FRAME_PEER_CONNECTED,
        otherId,
        assignedPeerId,
        Buffer.from(
          JSON.stringify({ peerId: otherId, yourPeerId: assignedPeerId, name: otherClient.name }),
          "utf-8"
        )
      )
    );
  }

  const joinNotice = makeFrame(
    FRAME_PEER_CONNECTED,
    assignedPeerId,
    0,
    Buffer.from(JSON.stringify({ peerId: assignedPeerId, name: clientName, skinId }), "utf-8")
  );
  room.hostWs.send(joinNotice);
  for (const [otherId, otherClient] of room.clients.entries()) {
    if (otherId !== assignedPeerId) {
      otherClient.ws.send(joinNotice);
    }
  }
  broadcastRoomInfo(room);

  ws.onMessage = (buf, isBinary) => {
    if (!isBinary || buf.length < 4) return;
    const frameType = buf[0];
    const targetPeer = (buf[1] << 8) | buf[2];
    const channel = buf[3];
    const payload = buf.subarray(4);

    if (frameType === FRAME_DATA || frameType === FRAME_WEBRTC_SIGNAL) {
      routePeerFrame(room, assignedPeerId, frameType, targetPeer, channel, payload);
    }
  };

  ws.onClose = () => {
    const current = room.clients.get(assignedPeerId);
    if (!current || current.ws !== ws) return;
    room.clients.delete(assignedPeerId);
    console.log(`[ROOM] Client peer=${assignedPeerId} left #${room.port}`);
    const discNotice = makeFrame(FRAME_PEER_DISCONNECTED, assignedPeerId, 0);
    room.hostWs.send(discNotice);
    for (const other of room.clients.values()) {
      other.ws.send(discNotice);
    }
    if (room.hostWs.isOpen) {
      broadcastRoomInfo(room);
    }
  };
});

server.listen(PORT, "0.0.0.0", () => {
  const lanIps = getLanAddresses();
  console.log(`\n========================================================`);
  console.log(`  GTA III WEB — ONLINE 4P CO-OP & PERSISTENCE SERVER`);
  console.log(`  Local URL : http://localhost:${PORT}`);
  for (const ip of lanIps) {
    console.log(`  LAN URL   : http://${ip}:${PORT}`);
  }
  console.log(`  WS Relay  : ws://localhost:${PORT}/ws?room=7777`);
  console.log(`========================================================\n`);
});
