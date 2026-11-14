const test = require("node:test");
const assert = require("node:assert/strict");
const MpCore = require("../public/mp_core.js");

function makeSampleState(overrides = {}) {
  const s = new Float32Array(28);
  s[0] = overrides.x ?? 812.0;
  s[1] = overrides.y ?? -938.0;
  s[2] = overrides.z ?? 15.0;
  s[3] = overrides.vx ?? 0.2;
  s[4] = overrides.vy ?? 0.0;
  s[5] = overrides.vz ?? 0.0;
  s[6] = overrides.heading ?? 0.5;
  s[7] = overrides.health ?? 100.0;
  s[8] = overrides.armor ?? 50.0;
  s[9] = overrides.model ?? 0;
  s[10] = overrides.weapon ?? 2;
  s[11] = overrides.anim ?? 1;
  s[12] = overrides.shooting ?? 0;
  s[13] = overrides.aimX ?? 820.0;
  s[14] = overrides.aimY ?? -938.0;
  s[15] = overrides.aimZ ?? 15.5;
  s[16] = overrides.inVeh ?? 0;
  s[17] = overrides.vehNetId ?? 0;
  s[18] = overrides.vehModel ?? 0;
  s[19] = overrides.seatIndex ?? 0;
  s[20] = overrides.vehX ?? 0;
  s[21] = overrides.vehY ?? 0;
  s[22] = overrides.vehZ ?? 0;
  s[23] = overrides.vehHeading ?? 0;
  s[24] = overrides.steer ?? 0;
  s[25] = overrides.gas ?? 0;
  s[26] = overrides.vehHealth ?? 1000.0;
  s[27] = overrides.colors ?? 0;
  return s;
}

test("isNewerSeq handles normal progression, duplicates, out-of-order, and 16-bit wrap-around", () => {
  assert.equal(MpCore.isNewerSeq(1, null), true);
  assert.equal(MpCore.isNewerSeq(2, 1), true);
  assert.equal(MpCore.isNewerSeq(2, 2), false);
  assert.equal(MpCore.isNewerSeq(1, 2), false);
  assert.equal(MpCore.isNewerSeq(0, 65535), true);
  assert.equal(MpCore.isNewerSeq(5, 65530), true);
  assert.equal(MpCore.isNewerSeq(65530, 5), false);
});

test("lerpAngleRad interpolates along the shortest arc across +/-PI", () => {
  const nearPosPi = Math.PI - 0.1;
  const nearNegPi = -Math.PI + 0.1;
  const mid = MpCore.lerpAngleRad(nearPosPi, nearNegPi, 0.5);
  assert.ok(Math.abs(Math.abs(mid) - Math.PI) < 1e-4, `Expected angle near PI, got ${mid}`);
});

test("encodePlayerStatePacket and decodePlayerStatePacket round-trip sequenced and legacy packets", () => {
  const state = makeSampleState({ x: 100.5, y: -250.25, z: 18.75, heading: -1.25 });
  const encoded = MpCore.encodePlayerStatePacket(2, "Tommy Vercetti", state, 4210, 12345);

  const decoded = MpCore.decodePlayerStatePacket(encoded);
  assert.ok(decoded);
  assert.equal(decoded.peerId, 2);
  assert.equal(decoded.playerName, "Tommy Vercetti");
  assert.equal(decoded.seq, 4210);
  assert.equal(decoded.timestampMs16, 12345);
  assert.ok(Math.abs(decoded.state[0] - 100.5) < 1e-5);
  assert.ok(Math.abs(decoded.state[1] - -250.25) < 1e-5);

  // Legacy packet without 4-byte seq/ts trailer
  const legacy = encoded.subarray(0, encoded.byteLength - 4);
  const decodedLegacy = MpCore.decodePlayerStatePacket(legacy);
  assert.ok(decodedLegacy);
  assert.equal(decodedLegacy.seq, null);
  assert.equal(decodedLegacy.playerName, "Tommy Vercetti");
  assert.ok(Math.abs(decodedLegacy.state[0] - 100.5) < 1e-5);

  // Reject NaN / out-of-bounds state
  const badState = makeSampleState({ x: Number.NaN });
  const badEncoded = MpCore.encodePlayerStatePacket(2, "Bad", badState, 1, 1);
  assert.equal(MpCore.decodePlayerStatePacket(badEncoded), null);
});

test("encodeVehicleSpawnPacket and encodePvpHitPacket support legacy and extended formats", () => {
  const vehPkt = MpCore.encodeVehicleSpawnPacket(105, 1, 2, 0, { x: 810.5, y: -920.25, z: 15.0, heading: 1.5 });
  assert.equal(vehPkt.byteLength, 22);
  const decVeh = MpCore.decodeVehicleSpawnPacket(vehPkt);
  assert.equal(decVeh.modelId, 105);
  assert.equal(decVeh.col1, 1);
  assert.equal(decVeh.col2, 2);
  assert.equal(decVeh.warp, false);
  assert.ok(Math.abs(decVeh.coords.x - 810.5) < 1e-4);

  const legacyVeh = new Uint8Array([MpCore.PKT_VEHICLE_SPAWN, 0, 92, 255, 255]);
  const decLegacyVeh = MpCore.decodeVehicleSpawnPacket(legacyVeh);
  assert.equal(decLegacyVeh.modelId, 92);
  assert.equal(decLegacyVeh.col1, -1);
  assert.equal(decLegacyVeh.coords, null);

  const hitPkt = MpCore.encodePvpHitPacket(3, 28, 6, 1);
  const decHit = MpCore.decodePvpHitPacket(hitPkt);
  assert.equal(decHit.targetPeerId, 3);
  assert.equal(decHit.damage, 28);
  assert.equal(decHit.weaponType, 6);
  assert.equal(decHit.attackerPeerId, 1);
});

test("computeRoutingPlan eliminates duplicate P2P + WebSocket Relay broadcasts", () => {
  // 1. All remote peers on P2P -> P2P only, 0 WS frames
  const planAllP2P = MpCore.computeRoutingPlan(1, [2, 3, 4], [2, 3, 4]);
  assert.deepEqual(planAllP2P.p2pTargets, [2, 3, 4]);
  assert.deepEqual(planAllP2P.wsTargets, []);

  // 2. No remote peers on P2P -> 0 P2P, 1 WS broadcast frame
  const planNoP2P = MpCore.computeRoutingPlan(2, [1, 3], []);
  assert.deepEqual(planNoP2P.p2pTargets, []);
  assert.deepEqual(planNoP2P.wsTargets, [{ targetOrPeerId: 0, channel: 2 }]);

  // 3. Partial P2P when Host (myPeerId = 1): P2P to [2, 3], targeted WS unicast (channel 0) to [4]
  const planHostPartial = MpCore.computeRoutingPlan(1, [2, 3, 4], [2, 3]);
  assert.deepEqual(planHostPartial.p2pTargets, [2, 3]);
  assert.deepEqual(planHostPartial.wsTargets, [{ targetOrPeerId: 4, channel: 0 }]);

  // 4. Partial P2P when Client (myPeerId = 2) and only Host (1) lacks P2P: P2P to [3], WS unicast (channel 1) to Host
  const planClientHostRelay = MpCore.computeRoutingPlan(2, [1, 3], [3]);
  assert.deepEqual(planClientHostRelay.p2pTargets, [3]);
  assert.deepEqual(planClientHostRelay.wsTargets, [{ targetOrPeerId: 1, channel: 1 }]);

  // 5. Partial P2P when Client (myPeerId = 2) and another Client (4) lacks P2P:
  // Uses single WS room broadcast (channel 2) and skips P2P so peer 3 never receives duplicate packets
  const planClientMixed = MpCore.computeRoutingPlan(2, [1, 3, 4], [1, 3]);
  assert.deepEqual(planClientMixed.p2pTargets, []);
  assert.deepEqual(planClientMixed.wsTargets, [{ targetOrPeerId: 0, channel: 2 }]);
});

test("PeerInterpolator smoothly interpolates 60Hz frames and drops out-of-order packets", () => {
  const interp = new MpCore.PeerInterpolator();
  const s1 = makeSampleState({ x: 100.0, y: 200.0, vx: 0.25, vy: 0.0, heading: 0.0 });
  const s2 = makeSampleState({ x: 100.5, y: 200.0, vx: 0.25, vy: 0.0, heading: 0.2 });
  const sOld = makeSampleState({ x: 50.0, y: 200.0, vx: 0.0, vy: 0.0, heading: 0.0 });

  assert.equal(interp.ingestPacket(2, s1, 10, 1000, "Player 2"), true);
  assert.equal(interp.ingestPacket(2, s2, 11, 1040, "Player 2"), true);

  // Out-of-order packet with seq=9 or duplicate seq=11 must be rejected
  assert.equal(interp.ingestPacket(2, sOld, 9, 1045, "Player 2"), false);
  assert.equal(interp.ingestPacket(2, sOld, 11, 1046, "Player 2"), false);

  // Midpoint sample at t = 1020ms should be smoothly between s1 and s2
  const mid = interp.sample(2, 1020);
  assert.ok(mid[0] > 100.0 && mid[0] < 100.6, `Expected mid[0] between 100.0 and 100.6, got ${mid[0]}`);

  // Teleport (>22m jump) snaps immediately without lagging across the map
  const sTeleport = makeSampleState({ x: 500.0, y: -300.0, z: 25.0 });
  assert.equal(interp.ingestPacket(2, sTeleport, 12, 1080, "Player 2"), true);
  const afterTp = interp.sample(2, 1082);
  assert.ok(Math.abs(afterTp[0] - 500.0) < 1.0, `Expected teleport snap near 500.0, got ${afterTp[0]}`);

  // Vehicle boarding & driving: discrete vehNetId (state[17]), vehModel (state[18]), and seatIndex (state[19])
  // must NEVER be corrupted by dead-reckoning or position interpolation, and vehPos (state[20..22]) must interpolate cleanly!
  const v1 = makeSampleState({
    x: 810.0,
    y: -930.0,
    z: 15.0,
    vx: 0.4,
    vy: 0.0,
    vz: 0.0,
    inVeh: 1,
    vehNetId: 42,
    vehModel: 110, // Taxi
    seatIndex: 0,
    vehX: 810.0,
    vehY: -930.0,
    vehZ: 15.0,
    vehHeading: 0.5,
    vehHealth: 1000.0,
    colors: 0x0201
  });
  const v2 = makeSampleState({
    x: 810.8,
    y: -930.0,
    z: 15.0,
    vx: 0.4,
    vy: 0.0,
    vz: 0.0,
    inVeh: 1,
    vehNetId: 42,
    vehModel: 110,
    seatIndex: 0,
    vehX: 810.8,
    vehY: -930.0,
    vehZ: 15.0,
    vehHeading: 0.55,
    vehHealth: 1000.0,
    colors: 0x0201
  });
  assert.equal(interp.ingestPacket(2, v1, 13, 1120, "Player 2"), true);
  assert.equal(interp.ingestPacket(2, v2, 14, 1160, "Player 2"), true);

  for (const sampleTime of [1140, 1210]) {
    const sv = interp.sample(2, sampleTime);
    assert.equal(sv[16], 1, "inVehicle flag preserved");
    assert.equal(sv[17], 42, "vehNetId must stay exact integer 42");
    assert.equal(sv[18], 110, "vehModelIndex must stay exact integer 110 (Taxi)");
    assert.equal(sv[19], 0, "seatIndex must stay exact integer 0 (driver)");
    assert.ok(sv[20] >= 810.0 && sv[20] <= 812.5, `vehX should remain near 810..812, got ${sv[20]}`);
    assert.ok(Math.abs(sv[21] - -930.0) < 0.01, `vehY should remain -930.0, got ${sv[21]}`);
    assert.equal(sv[0], sv[20], "ped X locked to vehicle X while driving");
    assert.equal(sv[1], sv[21], "ped Y locked to vehicle Y while driving");
  }
});

test("PvpCombatTracker detects weapon hits and vehicle ramming with cooldowns", () => {
  const tracker = new MpCore.PvpCombatTracker();
  const localShooter = makeSampleState({
    x: 100,
    y: 100,
    z: 15,
    weapon: 5, // AK-47
    shooting: 1,
    aimX: 115,
    aimY: 100,
    aimZ: 15
  });
  const remoteTarget = makeSampleState({
    x: 112,
    y: 100.3,
    z: 15,
    health: 100
  });
  const remoteMap = new Map([[2, remoteTarget]]);

  const hits1 = tracker.evaluateHits(localShooter, remoteMap, 2000);
  assert.equal(hits1.length, 1);
  assert.equal(hits1[0].targetPeerId, 2);
  assert.equal(hits1[0].weaponType, 5);
  assert.equal(hits1[0].damage, 22);

  // Immediate re-evaluation within cooldown (130ms for AK-47) should not emit duplicate hit
  const hitsCooldown = tracker.evaluateHits(localShooter, remoteMap, 2050);
  assert.equal(hitsCooldown.length, 0);

  // After cooldown expires, hit is emitted again
  const hits2 = tracker.evaluateHits(localShooter, remoteMap, 2150);
  assert.equal(hits2.length, 1);
});

test("WorldEnvironmentState preserves time when changing weather and preserves weather when changing time", () => {
  const env = new MpCore.WorldEnvironmentState();
  env.setWeather(2); // Rainy
  env.setTime(20, 30); // 20:30 Dusk
  assert.deepEqual(env.snapshot(), { weatherId: 2, hour: 20, minute: 30, mode: "freeroam", island: 1 });

  // Changing weather to Foggy (3) must keep time at 20:30!
  env.setWeather(3);
  assert.equal(env.weatherId, 3);
  assert.equal(env.hour, 20);
  assert.equal(env.minute, 30);

  // Changing time to 06:00 Dawn must keep weather at Foggy (3)!
  env.setTime(6, 0);
  assert.equal(env.weatherId, 3);
  assert.equal(env.hour, 6);
  assert.equal(env.minute, 0);

  // Extended PKT_WORLD_SYNC with wanted stars
  const pktWanted = MpCore.encodeWorldSyncPacket(3, 6, 0, 4, false);
  assert.equal(pktWanted.byteLength, 5);
  const decWanted = MpCore.decodeWorldSyncPacket(pktWanted);
  assert.equal(decWanted.weatherId, 3);
  assert.equal(decWanted.hour, 6);
  assert.equal(decWanted.wantedStars, 4);
  assert.equal(decWanted.neverWanted, false);
});

test("shouldBlockEngineInput blocks premature clicks/keys during loading and UI capture while allowing Main Menu (7), Gameplay (9), and F2/F3", () => {
  // During startup (0..6) and world loading splash (8), engine input is blocked
  for (const gs of [0, 1, 5, 6, 8]) {
    assert.equal(MpCore.shouldBlockEngineInput({ gameState: gs, isUiCapturing: false }), true);
  }
  // If HTML loading screen overlay is still visible, block even if state reads 7 or 9
  assert.equal(MpCore.shouldBlockEngineInput({ gameState: 7, isUiCapturing: false, isLoadingScreenVisible: true }), true);
  // Main Menu (gameState === 7) and Gameplay (gameState === 9) allow engine input when no overlay/modal is active
  assert.equal(MpCore.shouldBlockEngineInput({ gameState: 7, isUiCapturing: false }), false);
  assert.equal(MpCore.shouldBlockEngineInput({ gameState: 9, isUiCapturing: false }), false);
  // When a modal or chat box is open, engine input is blocked even in-game or Main Menu
  assert.equal(MpCore.shouldBlockEngineInput({ gameState: 7, isUiCapturing: true }), true);
  assert.equal(MpCore.shouldBlockEngineInput({ gameState: 9, isUiCapturing: true }), true);
  // F2/F3 UI hotkeys are never blocked
  assert.equal(MpCore.shouldBlockEngineInput({ gameState: 0, isUiCapturing: true, key: "F2" }), false);
  assert.equal(MpCore.shouldBlockEngineInput({ gameState: 0, isUiCapturing: true, key: "F3" }), false);
});

test("re3_wasm.wasm binary passes WebAssembly.validate()", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const wasmBuf = fs.readFileSync(path.resolve(__dirname, "../public/engine/re3_wasm.wasm"));
  assert.equal(WebAssembly.validate(wasmBuf), true);
});

