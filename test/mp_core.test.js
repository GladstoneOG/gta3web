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
  s[9] = overrides.weapon ?? 2;
  s[10] = overrides.model ?? 0;
  s[11] = overrides.anim ?? 1;
  s[12] = overrides.shooting ?? 0;
  s[13] = overrides.aimX ?? 820.0;
  s[14] = overrides.aimY ?? -938.0;
  s[15] = overrides.aimZ ?? 15.5;
  s[16] = overrides.inVeh ?? 0;
  s[17] = overrides.vehX ?? 0;
  s[18] = overrides.vehY ?? 0;
  s[19] = overrides.vehZ ?? 0;
  s[20] = overrides.vehVx ?? 0;
  s[21] = overrides.vehVy ?? 0;
  s[22] = overrides.vehVz ?? 0;
  s[23] = overrides.vehHeading ?? 0;
  s[24] = overrides.steer ?? 0;
  s[25] = overrides.gas ?? 0;
  s[26] = overrides.brake ?? 0;
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
});
