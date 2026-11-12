/**
 * GTA III Web — Multiplayer Protocol, Routing, 60Hz State Interpolator & Combat Core
 * Universal module (works in Browser via window.GTA3MpCore and Node.js via CommonJS/ESM).
 * Zero external dependencies.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GTA3MpCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Relay WebSocket Binary Frame Types (matches server.js & cloudflare_worker.js)
  const FRAME_DATA = 0x01;
  const FRAME_PEER_CONNECTED = 0x02;
  const FRAME_PEER_DISCONNECTED = 0x03;
  const FRAME_KICK_PEER = 0x04;
  const FRAME_ROOM_INFO = 0x05;
  const FRAME_HOST_ASSIGNED = 0x06;
  const FRAME_REJECTED = 0x07;

  // Game Packet Subtypes inside FRAME_DATA / WebRTC DataChannel
  const PKT_PLAYER_STATE = 0x10;
  const PKT_WORLD_SYNC = 0x11;
  const PKT_VEHICLE_SPAWN = 0x12;
  const PKT_CHAT = 0x13;
  const PKT_PVP_HIT = 0x14;
  const PKT_AMBIENT_SYNC = 0x15;
  const PKT_AMBIENT_HIT = 0x16;
  const PKT_PEER_NAME = 0x17;
  const PKT_RTC_SIGNAL = 0x30;

  const STATE_FLOAT_COUNT = 28;
  const STATE_BYTE_LENGTH = STATE_FLOAT_COUNT * 4; // 112 bytes

  // GTA III weapon base PvP damage & fire-rate cooldowns (ms)
  const WEAPON_DAMAGE_TABLE = {
    0: { damage: 8, cooldownMs: 350, range: 2.4, coneCos: 0.5 },    // Unarmed / Fist
    1: { damage: 18, cooldownMs: 420, range: 2.8, coneCos: 0.5 },   // Baseball Bat
    2: { damage: 15, cooldownMs: 220, range: 45.0, coneCos: 0.94 }, // Colt 45 Pistol
    3: { damage: 12, cooldownMs: 110, range: 40.0, coneCos: 0.92 }, // Uzi Submachine Gun
    4: { damage: 42, cooldownMs: 750, range: 28.0, coneCos: 0.88 }, // Shotgun
    5: { damage: 22, cooldownMs: 130, range: 65.0, coneCos: 0.95 }, // AK-47
    6: { damage: 28, cooldownMs: 110, range: 85.0, coneCos: 0.96 }, // M16
    7: { damage: 75, cooldownMs: 900, range: 110.0, coneCos: 0.96 },// Sniper Rifle
    8: { damage: 95, cooldownMs: 1200, range: 90.0, coneCos: 0.80 },// Rocket Launcher
    9: { damage: 10, cooldownMs: 150, range: 12.0, coneCos: 0.75 }, // Flamethrower
    10: { damage: 45, cooldownMs: 800, range: 30.0, coneCos: 0.70 },// Molotov
    11: { damage: 65, cooldownMs: 800, range: 35.0, coneCos: 0.70 } // Grenade
  };

  /**
   * RFC 1982 16-bit sequence number comparison.
   * Returns true if `incomingSeq` is strictly newer than `lastSeq`.
   */
  function isNewerSeq(incomingSeq, lastSeq) {
    if (lastSeq === null || lastSeq === undefined || lastSeq < 0) return true;
    const a = incomingSeq & 0xffff;
    const b = lastSeq & 0xffff;
    if (a === b) return false;
    const diff = (a - b) & 0xffff;
    return diff > 0 && diff < 0x8000;
  }

  /**
   * Shortest-arc angle normalization into [-PI, PI].
   */
  function normalizeAngleRad(angle) {
    if (!Number.isFinite(angle)) return 0;
    const twoPi = Math.PI * 2;
    let a = angle % twoPi;
    if (a > Math.PI) a -= twoPi;
    if (a < -Math.PI) a += twoPi;
    return a;
  }

  /**
   * Shortest-arc angular interpolation between two angles in radians.
   */
  function lerpAngleRad(fromRad, toRad, t) {
    if (!Number.isFinite(fromRad)) return Number.isFinite(toRad) ? toRad : 0;
    if (!Number.isFinite(toRad)) return fromRad;
    const clampedT = t < 0 ? 0 : t > 1 ? 1 : t;
    const delta = normalizeAngleRad(toRad - fromRad);
    return normalizeAngleRad(fromRad + delta * clampedT);
  }

  /**
   * Validates that a 28-float player/vehicle state array contains no NaN or Infinity values,
   * and that coordinates are within sane Liberty City bounds.
   */
  function isFiniteState28(state) {
    if (!state || state.length < STATE_FLOAT_COUNT) return false;
    for (let i = 0; i < STATE_FLOAT_COUNT; i++) {
      if (!Number.isFinite(state[i])) return false;
    }
    if (Math.abs(state[0]) > 4500 || Math.abs(state[1]) > 4500 || Math.abs(state[2]) > 2000) {
      return false;
    }
    return true;
  }

  function encodePlayerNameBytes(name) {
    const cleaned = String(name || "Claude Speed").trim() || "Claude Speed";
    const bytes = new TextEncoder().encode(cleaned);
    return bytes.length > 24 ? bytes.subarray(0, 24) : bytes;
  }

  /**
   * Encodes a PKT_PLAYER_STATE packet (backwards-compatible with [0x10, peerId, nameLen, ...name, ...112B float32]
   * plus 4-byte [seqHi, seqLo, tsHi, tsLo] trailer).
   */
  function encodePlayerStatePacket(peerId, playerName, state28, seq = 0, timestampMs = 0) {
    const nameBytes =
      playerName instanceof Uint8Array ? playerName : encodePlayerNameBytes(playerName);
    const out = new Uint8Array(3 + nameBytes.length + STATE_BYTE_LENGTH + 4);
    out[0] = PKT_PLAYER_STATE;
    out[1] = peerId & 0xff;
    out[2] = nameBytes.length & 0xff;
    out.set(nameBytes, 3);

    const floatOffset = 3 + nameBytes.length;
    const f32 = state28 instanceof Float32Array ? state28 : new Float32Array(state28);
    out.set(new Uint8Array(f32.buffer, f32.byteOffset, STATE_BYTE_LENGTH), floatOffset);

    const trailerOffset = floatOffset + STATE_BYTE_LENGTH;
    const s = seq & 0xffff;
    const ts = (timestampMs | 0) & 0xffff;
    out[trailerOffset] = (s >> 8) & 0xff;
    out[trailerOffset + 1] = s & 0xff;
    out[trailerOffset + 2] = (ts >> 8) & 0xff;
    out[trailerOffset + 3] = ts & 0xff;
    return out;
  }

  /**
   * Decodes a PKT_PLAYER_STATE binary payload (supports both legacy unsequenced and sequenced packets).
   */
  function decodePlayerStatePacket(payload) {
    if (!payload || payload.byteLength < 3 + STATE_BYTE_LENGTH) return null;
    if (payload[0] !== PKT_PLAYER_STATE) return null;
    const peerId = payload[1] & 0xff;
    const nameLen = payload[2] & 0xff;
    const floatOffset = 3 + nameLen;
    if (payload.byteLength < floatOffset + STATE_BYTE_LENGTH) return null;

    const nameBytes = payload.subarray(3, 3 + Math.min(nameLen, 31));
    const playerName = new TextDecoder().decode(nameBytes).trim() || `Player ${peerId || 1}`;

    const state = new Float32Array(STATE_FLOAT_COUNT);
    const view = new DataView(payload.buffer, payload.byteOffset + floatOffset, STATE_BYTE_LENGTH);
    for (let i = 0; i < STATE_FLOAT_COUNT; i++) {
      state[i] = view.getFloat32(i * 4, true);
    }
    if (!isFiniteState28(state)) return null;

    let seq = null;
    let timestampMs16 = null;
    const trailerOffset = floatOffset + STATE_BYTE_LENGTH;
    if (payload.byteLength >= trailerOffset + 4) {
      seq = ((payload[trailerOffset] << 8) | payload[trailerOffset + 1]) & 0xffff;
      timestampMs16 = ((payload[trailerOffset + 2] << 8) | payload[trailerOffset + 3]) & 0xffff;
    }
    return { peerId, playerName, nameBytes, state, seq, timestampMs16 };
  }

  /**
   * Encodes a PKT_VEHICLE_SPAWN packet with optional world position and heading.
   * Format (22 bytes with coords, 6 bytes without):
   * [0x12, modelHi, modelLo, col1, col2, warpFlag, x(f32), y(f32), z(f32), heading(f32)]
   */
  function encodeVehicleSpawnPacket(modelId, col1 = -1, col2 = -1, warp = 0, coords = null) {
    const hasCoords =
      coords &&
      Number.isFinite(coords.x) &&
      Number.isFinite(coords.y) &&
      Number.isFinite(coords.z);
    const pkt = new Uint8Array(hasCoords ? 22 : 6);
    pkt[0] = PKT_VEHICLE_SPAWN;
    pkt[1] = (modelId >> 8) & 0xff;
    pkt[2] = modelId & 0xff;
    pkt[3] = col1 < 0 ? 255 : col1 & 0xff;
    pkt[4] = col2 < 0 ? 255 : col2 & 0xff;
    pkt[5] = warp ? 1 : 0;
    if (hasCoords) {
      const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
      dv.setFloat32(6, coords.x, true);
      dv.setFloat32(10, coords.y, true);
      dv.setFloat32(14, coords.z, true);
      dv.setFloat32(18, Number.isFinite(coords.heading) ? coords.heading : 0, true);
    }
    return pkt;
  }

  /**
   * Decodes a PKT_VEHICLE_SPAWN packet (supports 5-byte legacy, 6-byte, and 22-byte coordinate packets).
   */
  function decodeVehicleSpawnPacket(payload) {
    if (!payload || payload.byteLength < 5 || payload[0] !== PKT_VEHICLE_SPAWN) return null;
    const modelId = ((payload[1] << 8) | payload[2]) & 0xffff;
    const col1 = payload[3] === 255 ? -1 : payload[3];
    const col2 = payload[4] === 255 ? -1 : payload[4];
    const warp = payload.byteLength >= 6 ? payload[5] === 1 : false;
    let coords = null;
    if (payload.byteLength >= 22) {
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const x = dv.getFloat32(6, true);
      const y = dv.getFloat32(10, true);
      const z = dv.getFloat32(14, true);
      const heading = dv.getFloat32(18, true);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        coords = { x, y, z, heading: Number.isFinite(heading) ? heading : 0 };
      }
    }
    return { modelId, col1, col2, warp, coords };
  }

  /**
   * Encodes a PKT_WORLD_SYNC packet:
   * [0x11, weatherId, hour, minute]
   */
  function encodeWorldSyncPacket(weatherId, hour, minute) {
    const pkt = new Uint8Array(4);
    pkt[0] = PKT_WORLD_SYNC;
    pkt[1] = weatherId & 0xff;
    pkt[2] = hour & 0xff;
    pkt[3] = minute & 0xff;
    return pkt;
  }

  /**
   * Decodes a PKT_WORLD_SYNC packet.
   */
  function decodeWorldSyncPacket(payload) {
    if (!payload || payload.byteLength < 4 || payload[0] !== PKT_WORLD_SYNC) return null;
    return {
      weatherId: payload[1] & 0x03,
      hour: payload[2] % 24,
      minute: payload[3] % 60
    };
  }

  /**
   * Encodes a PKT_PVP_HIT packet (matches legacy [0x14, targetPeerId, damageU8, weaponTypeU8] + attackerPeerId):
   * [0x14, targetPeerId, damageU8, weaponTypeU8, attackerPeerIdU8]
   */
  function encodePvpHitPacket(targetPeerId, damage, weaponType, attackerPeerId = 0) {
    const pkt = new Uint8Array(5);
    pkt[0] = PKT_PVP_HIT;
    pkt[1] = targetPeerId & 0xff;
    pkt[2] = Math.max(1, Math.min(255, Math.round(Number(damage) || 0))) & 0xff;
    pkt[3] = weaponType & 0xff;
    pkt[4] = attackerPeerId & 0xff;
    return pkt;
  }

  /**
   * Decodes a PKT_PVP_HIT packet (supports 4-byte legacy and 5-byte extended format).
   */
  function decodePvpHitPacket(payload) {
    if (!payload || payload.byteLength < 4 || payload[0] !== PKT_PVP_HIT) return null;
    const damage = payload[2] & 0xff;
    if (damage <= 0) return null;
    return {
      targetPeerId: payload[1] & 0xff,
      damage,
      weaponType: payload[3] & 0xff,
      attackerPeerId: payload.byteLength >= 5 ? payload[4] & 0xff : 0
    };
  }

  /**
   * Wraps a game packet inside a Relay WebSocket FRAME_DATA envelope.
   */
  function buildRelayDataFrame(targetOrPeerId, channel, pktPayload) {
    const out = new Uint8Array(4 + pktPayload.byteLength);
    out[0] = FRAME_DATA;
    out[1] = (targetOrPeerId >> 8) & 0xff;
    out[2] = targetOrPeerId & 0xff;
    out[3] = channel & 0xff;
    out.set(pktPayload, 4);
    return out;
  }

  /**
   * Computes an optimal, duplicate-free routing plan for broadcasting high-frequency state or ambient
   * packets to connected peers.
   *
   * Fixes the severe bug where having a mix of P2P-open peers and Relay-only peers caused the sender
   * to transmit over WebRTC DataChannel AND broadcast to the entire room over WebSocket Relay,
   * delivering every packet twice at different latencies and causing severe rubber-banding.
   */
  function computeRoutingPlan(myPeerId, connectedPeerIds, p2pOpenPeerIds, defaultWsChannel = 2) {
    const remoteIds = [];
    const openSet = new Set(p2pOpenPeerIds || []);
    for (const id of connectedPeerIds || []) {
      if (id && id !== myPeerId) remoteIds.push(id);
    }
    if (remoteIds.length === 0) {
      return { p2pTargets: [], wsTargets: [] };
    }

    const p2pAvailable = [];
    const relayNeeded = [];
    for (const id of remoteIds) {
      if (openSet.has(id)) {
        p2pAvailable.push(id);
      } else {
        relayNeeded.push(id);
      }
    }

    // Case 1: All remote peers have open P2P DataChannels -> 100% WebRTC P2P, 0 WebSocket frames
    if (relayNeeded.length === 0) {
      return { p2pTargets: p2pAvailable, wsTargets: [] };
    }

    // Case 2: No remote peers have P2P open -> single WebSocket broadcast frame
    if (p2pAvailable.length === 0) {
      const targetOrPeerId = 0;
      const channel = myPeerId === 1 ? 0 : defaultWsChannel;
      return {
        p2pTargets: [],
        wsTargets: [{ targetOrPeerId, channel }]
      };
    }

    // Case 3: Partial P2P mesh (some peers on P2P, some still negotiating / on Relay)
    // If we are Host (peerId === 1), the Relay Server supports unicasting to specific client IDs via channel 0!
    if (myPeerId === 1) {
      return {
        p2pTargets: p2pAvailable,
        wsTargets: relayNeeded.map((pid) => ({ targetOrPeerId: pid, channel: 0 }))
      };
    }

    // If we are a Client (myPeerId > 1):
    // Check if the ONLY peer needing relay is Host (peerId === 1).
    // Channel 1 on the Relay Server unicasts strictly from Client -> Host!
    if (relayNeeded.length === 1 && relayNeeded[0] === 1) {
      return {
        p2pTargets: p2pAvailable,
        wsTargets: [{ targetOrPeerId: 1, channel: 1 }]
      };
    }

    // Otherwise, another Client (peerId >= 2) needs Relay. Since Client channel 2 broadcasts to ALL peers
    // in the room on the server, we must NOT also send via P2P for this frame, or P2P peers would get duplicates!
    return {
      p2pTargets: [],
      wsTargets: [{ targetOrPeerId: 0, channel: defaultWsChannel }]
    };
  }

  /**
   * 60 FPS Remote Peer & Vehicle State Interpolator.
   *
   * Eliminates 25 Hz packet snapping, out-of-order UDP rollback, and unbounded dead-reckoning overshoot.
   */
  class PeerInterpolator {
    constructor(options = {}) {
      this.peers = new Map();
      // GTA III's velocity vectors (state[3..5] and state[20..22]) are in meters per 50Hz simulation tick (20ms).
      this.tickRateHz = options.tickRateHz || 50;
      this.maxExtrapolationMs = options.maxExtrapolationMs || 110;
      this.pedTeleportThresholdSq = (options.pedTeleportThreshold || 22) ** 2;
      this.vehTeleportThresholdSq = (options.vehTeleportThreshold || 35) ** 2;
    }

    removePeer(peerId) {
      this.peers.delete(peerId);
    }

    clear() {
      this.peers.clear();
    }

    getPeerEntry(peerId) {
      return this.peers.get(peerId) || null;
    }

    /**
     * Ingests a newly received 28-float state vector for `peerId`.
     * Returns true if accepted, false if rejected (invalid or out-of-order sequence number).
     */
    ingestPacket(peerId, state28, seq = null, nowMs = performance.now(), playerName = null) {
      if (!isFiniteState28(state28)) return false;

      let entry = this.peers.get(peerId);
      if (entry && seq !== null && entry.lastSeq !== null) {
        if (!isNewerSeq(seq, entry.lastSeq)) {
          entry.droppedOutOfOrder++;
          return false;
        }
      }

      const incoming = new Float32Array(state28);
      if (!entry) {
        entry = {
          peerId,
          playerName: playerName || `Player ${peerId}`,
          nameBytes: encodePlayerNameBytes(playerName || `Player ${peerId}`),
          lastSeq: seq,
          lastArrivalMs: nowMs,
          emaIntervalMs: 40, // 25 Hz nominal
          prevState: new Float32Array(incoming),
          targetState: new Float32Array(incoming),
          displayState: new Float32Array(incoming),
          packetsAccepted: 1,
          droppedOutOfOrder: 0
        };
        this.peers.set(peerId, entry);
        return true;
      }

      if (playerName && playerName !== entry.playerName) {
        entry.playerName = playerName;
        entry.nameBytes = encodePlayerNameBytes(playerName);
      }

      // Sample current display position at `nowMs` so the new interpolation curve starts
      // seamlessly from where the peer is currently rendered on screen (C0 continuity!).
      const currentRendered = this.sample(peerId, nowMs) || entry.displayState;

      const dtArrival = Math.max(1, nowMs - entry.lastArrivalMs);
      if (dtArrival < 250) {
        entry.emaIntervalMs = entry.emaIntervalMs * 0.75 + Math.min(120, Math.max(16, dtArrival)) * 0.25;
      } else {
        entry.emaIntervalMs = 40;
      }

      // Check for teleport or vehicle entry/exit state transition
      const dx = incoming[0] - currentRendered[0];
      const dy = incoming[1] - currentRendered[1];
      const dz = incoming[2] - currentRendered[2];
      const pedDistSq = dx * dx + dy * dy + dz * dz;

      const wasInVeh = currentRendered[16] > 0.5;
      const nowInVeh = incoming[16] > 0.5;
      const vdx = incoming[17] - currentRendered[17];
      const vdy = incoming[18] - currentRendered[18];
      const vdz = incoming[19] - currentRendered[19];
      const vehDistSq = vdx * vdx + vdy * vdy + vdz * vdz;

      const pedTeleported = pedDistSq > this.pedTeleportThresholdSq;
      const vehTeleported = !wasInVeh || !nowInVeh || vehDistSq > this.vehTeleportThresholdSq;

      entry.prevState.set(currentRendered);
      if (pedTeleported) {
        entry.prevState[0] = incoming[0];
        entry.prevState[1] = incoming[1];
        entry.prevState[2] = incoming[2];
        entry.prevState[6] = incoming[6];
        entry.displayState[0] = incoming[0];
        entry.displayState[1] = incoming[1];
        entry.displayState[2] = incoming[2];
        entry.displayState[6] = incoming[6];
      }
      if (vehTeleported) {
        for (let i = 16; i < 28; i++) {
          entry.prevState[i] = incoming[i];
          entry.displayState[i] = incoming[i];
        }
      }

      entry.targetState.set(incoming);
      entry.lastSeq = seq !== null ? seq : entry.lastSeq;
      entry.lastArrivalMs = nowMs;
      entry.packetsAccepted++;
      return true;
    }

    /**
     * Samples the smoothly interpolated 28-float state for `peerId` at `nowMs`.
     * Designed to be called at 60Hz+ inside `requestAnimationFrame`.
     */
    sample(peerId, nowMs = performance.now()) {
      const entry = this.peers.get(peerId);
      if (!entry) return null;

      const prev = entry.prevState;
      const target = entry.targetState;
      const out = entry.displayState;

      const elapsedMs = Math.max(0, nowMs - entry.lastArrivalMs);
      const durationMs = Math.max(20, Math.min(100, entry.emaIntervalMs));
      const alpha = Math.min(1, elapsedMs / durationMs);
      // Smoothstep blend factor during the arrival window
      const smoothAlpha = alpha * alpha * (3 - 2 * alpha);

      // Extrapolation past target arrival window (bounded & exponentially damped)
      const extraMs = Math.max(0, Math.min(this.maxExtrapolationMs, elapsedMs - durationMs * 0.5));
      const extraTicks = (extraMs / 1000) * this.tickRateHz;
      const extraDamping = Math.exp(-extraMs / 90);

      // Copy discrete fields directly from latest target state
      out.set(target);

      // --- 1. Pedestrian Position, Velocity & Heading ---
      const pvx = prev[3] + (target[3] - prev[3]) * alpha;
      const pvy = prev[4] + (target[4] - prev[4]) * alpha;
      const pvz = Math.abs(target[5]) < 0.03 ? 0 : prev[5] + (target[5] - prev[5]) * alpha;

      const projTargetX = target[0] + target[3] * extraTicks * extraDamping;
      const projTargetY = target[1] + target[4] * extraTicks * extraDamping;
      const projTargetZ = target[2] + (Math.abs(target[5]) < 0.03 ? 0 : target[5] * extraTicks * extraDamping);

      out[0] = prev[0] + (projTargetX - prev[0]) * smoothAlpha;
      out[1] = prev[1] + (projTargetY - prev[1]) * smoothAlpha;
      out[2] = prev[2] + (projTargetZ - prev[2]) * smoothAlpha;
      out[3] = pvx * extraDamping;
      out[4] = pvy * extraDamping;
      out[5] = pvz * extraDamping;
      out[6] = lerpAngleRad(prev[6], target[6], smoothAlpha);

      // Smooth aim target when shooting
      if (target[12] > 0.5) {
        out[13] = prev[13] + (target[13] - prev[13]) * smoothAlpha;
        out[14] = prev[14] + (target[14] - prev[14]) * smoothAlpha;
        out[15] = prev[15] + (target[15] - prev[15]) * smoothAlpha;
      }

      // --- 2. Vehicle Position, Velocity, Heading & Pedals ---
      if (target[16] > 0.5) {
        const vvx = prev[20] + (target[20] - prev[20]) * alpha;
        const vvy = prev[21] + (target[21] - prev[21]) * alpha;
        const vvz = Math.abs(target[22]) < 0.025 ? 0 : prev[22] + (target[22] - prev[22]) * alpha;

        const projVehX = target[17] + target[20] * extraTicks * extraDamping;
        const projVehY = target[18] + target[21] * extraTicks * extraDamping;
        const projVehZ = target[19] + (Math.abs(target[22]) < 0.025 ? 0 : target[22] * extraTicks * extraDamping);

        out[17] = prev[17] + (projVehX - prev[17]) * smoothAlpha;
        out[18] = prev[18] + (projVehY - prev[18]) * smoothAlpha;
        out[19] = prev[19] + (projVehZ - prev[19]) * smoothAlpha;
        out[20] = vvx * extraDamping;
        out[21] = vvy * extraDamping;
        out[22] = vvz * extraDamping;
        out[23] = lerpAngleRad(prev[23], target[23], smoothAlpha);
        out[24] = prev[24] + (target[24] - prev[24]) * smoothAlpha; // steerAngle
        out[25] = prev[25] + (target[25] - prev[25]) * smoothAlpha; // gasPedal
        out[26] = prev[26] + (target[26] - prev[26]) * smoothAlpha; // brakePedal

        // Keep driver ped position locked to vehicle position so nametag & ped never lag behind car
        out[0] = out[17];
        out[1] = out[18];
        out[2] = out[19];
        out[3] = out[20];
        out[4] = out[21];
        out[5] = out[22];
        out[6] = out[23];
      }

      return out;
    }
  }

  /**
   * Tracks local player attacks against remote peers and emits rate-limited PKT_PVP_HIT events.
   */
  class PvpCombatTracker {
    constructor() {
      this.lastWeaponHitMs = new Map();
      this.lastRamHitMs = new Map();
    }

    /**
     * Evaluates whether the local player's current weapon fire or vehicle ramming hits any remote peer.
     */
    evaluateHits(localState, remoteStates, nowMs = performance.now()) {
      const hits = [];
      if (!localState || !remoteStates || remoteStates.size === 0) return hits;

      const lx = localState[0];
      const ly = localState[1];
      const lz = localState[2];
      const localInVeh = localState[16] > 0.5;

      // 1. Check high-speed vehicle ramming against on-foot remote peers
      if (localInVeh && Math.round(localState[16]) === 1) {
        const vx = localState[20];
        const vy = localState[21];
        const speedPerTick = Math.hypot(vx, vy);
        if (speedPerTick > 0.18) {
          const vhx = localState[17];
          const vhy = localState[18];
          const vhz = localState[19];
          for (const [peerId, rState] of remoteStates.entries()) {
            if (!rState || rState[7] <= 0 || rState[16] > 0.5) continue;
            const lastRam = this.lastRamHitMs.get(peerId) || 0;
            if (nowMs - lastRam < 750) continue;
            const dx = rState[0] - vhx;
            const dy = rState[1] - vhy;
            const dz = rState[2] - vhz;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq < 9.0 && Math.abs(dz) < 2.2) {
              const dot = dx * vx + dy * vy;
              if (dot > 0) {
                this.lastRamHitMs.set(peerId, nowMs);
                const damage = Math.min(65, Math.max(15, Math.round(speedPerTick * 95)));
                hits.push({ targetPeerId: peerId, damage, weaponType: 50 });
              }
            }
          }
        }
      }

      // 2. Check weapon firing / melee attacks
      const isShooting = localState[12] > 0.5;
      if (!isShooting || localInVeh) return hits;

      const weaponId = Math.max(0, Math.min(11, Math.round(localState[9])));
      const spec = WEAPON_DAMAGE_TABLE[weaponId] || WEAPON_DAMAGE_TABLE[0];

      let dirX = localState[13] - lx;
      let dirY = localState[14] - ly;
      let dirZ = localState[15] - (lz + 0.5);
      let dirLen = Math.hypot(dirX, dirY, dirZ);
      if (dirLen < 0.05) {
        const h = localState[6];
        dirX = -Math.sin(h);
        dirY = Math.cos(h);
        dirZ = 0;
      } else {
        dirX /= dirLen;
        dirY /= dirLen;
        dirZ /= dirLen;
      }

      for (const [peerId, rState] of remoteStates.entries()) {
        if (!rState || rState[7] <= 0) continue;
        const lastHit = this.lastWeaponHitMs.get(peerId) || 0;
        if (nowMs - lastHit < spec.cooldownMs) continue;

        const tx = rState[0] - lx;
        const ty = rState[1] - ly;
        const tz = rState[2] - lz;
        const dist = Math.hypot(tx, ty, tz);
        if (dist < 0.1 || dist > spec.range) continue;

        const cosAngle = (tx * dirX + ty * dirY + tz * dirZ) / dist;
        const hitRadius = rState[16] > 0.5 ? 2.2 : 1.35;
        const proj = Math.max(0, tx * dirX + ty * dirY + tz * dirZ);
        const perpX = tx - dirX * proj;
        const perpY = ty - dirY * proj;
        const perpZ = tz - dirZ * proj;
        const perpDist = Math.hypot(perpX, perpY, perpZ);

        if (cosAngle >= spec.coneCos || (dist <= 3.0 && cosAngle > 0.2) || (proj > 0 && perpDist <= hitRadius)) {
          this.lastWeaponHitMs.set(peerId, nowMs);
          hits.push({
            targetPeerId: peerId,
            damage: spec.damage,
            weaponType: weaponId
          });
        }
      }

      return hits;
    }
  }

  /**
   * Maintains authoritative room environment settings (weather, time of day, mode, island)
   * so changing weather never resets the clock and changing time never resets the weather.
   */
  class WorldEnvironmentState {
    constructor() {
      this.weatherId = 0; // 0 = Sunny, 1 = Cloudy, 2 = Rainy, 3 = Foggy
      this.hour = 12;
      this.minute = 0;
      this.mode = "freeroam";
      this.island = 1;
    }

    setWeather(weatherId) {
      if (Number.isFinite(weatherId) && weatherId >= 0 && weatherId <= 3) {
        this.weatherId = weatherId | 0;
      }
      return this.snapshot();
    }

    setTime(hour, minute = 0) {
      if (Number.isFinite(hour)) {
        this.hour = ((hour | 0) % 24 + 24) % 24;
      }
      if (Number.isFinite(minute)) {
        this.minute = ((minute | 0) % 60 + 60) % 60;
      }
      return this.snapshot();
    }

    applyPacket(decoded) {
      if (!decoded) return this.snapshot();
      if (Number.isFinite(decoded.weatherId)) this.weatherId = decoded.weatherId & 0x03;
      if (Number.isFinite(decoded.hour)) this.hour = decoded.hour % 24;
      if (Number.isFinite(decoded.minute)) this.minute = decoded.minute % 60;
      return this.snapshot();
    }

    snapshot() {
      return {
        weatherId: this.weatherId,
        hour: this.hour,
        minute: this.minute,
        mode: this.mode,
        island: this.island
      };
    }
  }

  return {
    FRAME_DATA,
    FRAME_PEER_CONNECTED,
    FRAME_PEER_DISCONNECTED,
    FRAME_KICK_PEER,
    FRAME_ROOM_INFO,
    FRAME_HOST_ASSIGNED,
    FRAME_REJECTED,
    PKT_PLAYER_STATE,
    PKT_WORLD_SYNC,
    PKT_VEHICLE_SPAWN,
    PKT_CHAT,
    PKT_PVP_HIT,
    PKT_AMBIENT_SYNC,
    PKT_AMBIENT_HIT,
    PKT_PEER_NAME,
    PKT_RTC_SIGNAL,
    STATE_FLOAT_COUNT,
    STATE_BYTE_LENGTH,
    WEAPON_DAMAGE_TABLE,
    isNewerSeq,
    normalizeAngleRad,
    lerpAngleRad,
    isFiniteState28,
    encodePlayerNameBytes,
    encodePlayerStatePacket,
    decodePlayerStatePacket,
    encodeVehicleSpawnPacket,
    decodeVehicleSpawnPacket,
    encodeWorldSyncPacket,
    decodeWorldSyncPacket,
    encodePvpHitPacket,
    decodePvpHitPacket,
    buildRelayDataFrame,
    computeRoutingPlan,
    PeerInterpolator,
    PvpCombatTracker,
    WorldEnvironmentState
  };
});
