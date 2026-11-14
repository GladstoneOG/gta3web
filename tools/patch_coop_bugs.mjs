import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(__dirname, "../public/engine/re3_wasm.wasm");
const backupPath = "/tmp/re3_wasm.wasm.pre_coop_fix";

if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(wasmPath, backupPath);
}

// Always patch from the clean pre-coop-fix baseline so the script is 100% idempotent
const orig = fs.readFileSync(backupPath);

function encodeULEB(val) {
  const out = [];
  let v = val >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

function readULEB(buf, pos) {
  let r = 0;
  let s = 0;
  let b;
  let p = pos;
  do {
    b = buf[p++];
    r |= (b & 0x7f) << s;
    s += 7;
  } while (b & 0x80);
  return { val: r >>> 0, next: p };
}

function assertHex(buf, start, end, expectedHex, label) {
  const actual = Array.from(buf.subarray(start, end))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  if (actual !== expectedHex) {
    throw new Error(`Byte mismatch at ${label} [${start}..${end}]:\n  expected: ${expectedHex}\n  actual:   ${actual}`);
  }
}

function fromHex(hexStr) {
  const clean = hexStr.trim().split(/\s+/).filter(Boolean);
  return Buffer.from(clean.map((h) => Number.parseInt(h, 16)));
}

// Verify exact baseline slices before patching
assertHex(
  orig,
  1194526,
  1194565,
  "20 03 45 0d 00 20 01 28 02 a4 03 22 00 45 0d 00 20 00 10 a8 0d 45 0d 00 20 01 20 01 28 02 50 41 87 7e 71 36 02 50 0b",
  "func 1572 epilogue"
);
assertHex(
  orig,
  1202190,
  1202200,
  "10 88 07 22 09 45 0d 00 02 40",
  "func 1589 FindPlayerPed start"
);
assertHex(
  orig,
  1202860,
  1202874,
  "01 28 02 d4 02 41 ff ff 77 71 36 02 d4 02",
  "func 1589 remote peer visibility mask"
);
assertHex(
  orig,
  1204087,
  1204116,
  "20 06 28 02 00 22 05 2d 00 94 06 41 01 46 04 40 20 05 10 a4 0c 20 07 28 02 00 21 04 0b",
  "func 1589 on-foot remote peer vehicle cleanup"
);
assertHex(
  orig,
  1204349,
  1204360,
  "20 01 10 a5 0c 0d 00 20 01 41 00",
  "func 1589 old vehicle release 1"
);
assertHex(
  orig,
  1206332,
  1206343,
  "20 0a 10 a5 0c 0d 00 20 0a 41 00",
  "func 1589 old vehicle release 2"
);
assertHex(
  orig,
  1206461,
  1206495,
  "20 0d 04 40 20 01 10 ab 0c 22 00 41 00 48 0d 01 20 06 28 02 00 20 01 20 00 41 01 6a 10 bc 0c 0c 01 0b",
  "func 1589 driver conflict seat fallback"
);
assertHex(
  orig,
  1209124,
  1209142,
  "20 03 10 a5 0c 04 40 20 00 21 01 0c 02 0b 20 03 41 00",
  "func 1589 client ambient vehicle release"
);
assertHex(
  orig,
  1210700,
  1210715,
  "20 02 28 02 d4 02 41 ff ff 77 71 36 02 d4 02",
  "func 1589 ambient ped visibility mask"
);
assertHex(
  orig,
  1216085,
  1216107,
  "20 06 20 07 47 0d 00 20 01 20 01 28 02 50 41 87 7e 71 36 02 50 0b",
  "func 1596 driver status restore"
);
assertHex(
  orig,
  1218699,
  1218710,
  "20 02 2d 00 94 06 41 01 47 04 40",
  "func 1610 inVehicle check"
);
assertHex(
  orig,
  1359444,
  1359512,
  "22 02 20 00 36 02 00 20 00 20 02 10 c2 07 0b 20 01 28 02 50 41 87 7e 71 21 02 02 40 20 00 28 02 ac 06 41 03 4d 04 40 20 01 20 02 36 02 50 10 86 02 20 01 10 eb 03 0c 01 0b 20 01 20 02 41 18 72 36 02 50 0b",
  "func 1757 passenger count & vehicle status"
);
assertHex(
  orig,
  1364070,
  1364087,
  "20 01 41 02 36 02 ac 04 0b 20 04 41 10 6a 24 00 0b",
  "func 1761 LeaveCarAnimCallback epilogue"
);
assertHex(
  orig,
  1709067,
  1709076,
  "20 00 10 a5 0c 45 0d 00 20",
  "func 2274 CAutomobile::ProcessControl remote check"
);
assertHex(
  orig,
  1833556,
  1833573,
  "20 00 20 00 2d 00 c8 03 41 01 6b 3a 00 c8 03 0b 0b",
  "func 2419 CVehicle::RemovePassenger decrement"
);

/**
 * Define surgical byte replacements sorted by file offset.
 * Each replacement stays strictly inside a single function body in Section 10 (Code).
 */
const replacements = [
  // 1. func 1572 (RemovePedFromVehicleCleanly, 1194328..1194566):
  // Clear ped->340 &= -655361 (~(0x20000|0x80000)), ped->788 = 0, ped->784 = 0, ped->780 = 0, ped->364 = 0, ped->352 = 0, ped->548 = 1;
  // Clear V->457..459 = 0 and V->501 &= -1048577;
  // Restore V->80 &= -16633 (~(248|16384)) and V->290 &= 253 when local player is driver.
  {
    start: 1194526,
    end: 1194565,
    bytes: fromHex(
      [
        // ped->340 &= -655361
        "20 00 20 00 28 02 d4 02 41 ff ff d7 fd 7f 71 36 02 d4 02",
        // ped->788 = 0, ped->784 = 0, ped->780 = 0, ped->364 = 0, ped->352 = 0, ped->548 = 1
        "20 00 41 00 3a 00 94 06",
        "20 00 41 00 36 02 90 06",
        "20 00 41 00 36 02 8c 06",
        "20 00 41 00 36 02 ec 02",
        "20 00 41 00 36 02 e0 02",
        "20 00 41 01 36 02 a4 04",
        // if (local 1 != 0) { V->457=0; V->458=0; V->459=0; V->501 &= -1048577; }
        "20 01 04 40",
        "20 01 41 00 3a 00 c9 03",
        "20 01 41 00 3a 00 ca 03",
        "20 01 41 00 3a 00 cb 03",
        "20 01 20 01 28 00 f5 03 41 ff ff bf ff 7f 71 36 00 f5 03",
        "0b",
        // Original driver check with -16633 mask and handbrake clear
        "20 03 45 0d 00 20 01 28 02 a4 03 22 00 45 0d 00 20 00 10 a8 0d 45 0d 00",
        "20 01 20 01 28 02 50 41 87 fd 7e 71 36 02 50",
        "20 01 20 01 2d 00 a2 02 41 fd 01 71 3a 00 a2 02",
        "0b"
      ].join(" ")
    )
  },

  // 2A. func 1589 (UpdateMultiplayerSync, 1202198):
  // Per-frame local player (local 9) vehicle & visibility sanitization (runs regardless of cheats):
  // - If local 9->788 == 1 (inVehicle): if (V = local 9->784) != 0 && V->420 == local 9 && (V->80 & 16632) != 0:
  //   clear V->80 &= -16633 and V->290 &= 253.
  // - Else (local 9->788 == 0): clear local 9->340 &= -655361, and if local 9->548 < 48 || local 9->548 > 52, clear local 9->784 = 0.
  {
    start: 1202198,
    end: 1202198,
    bytes: fromHex(
      [
        "20 09 2d 00 94 06 41 01 46 04 40",
        // inVehicle == 1:
        "20 09 28 02 90 06 22 03 04 40",
        "20 03 28 02 a4 03 20 09 46 04 40",
        "20 03 28 02 50 41 f8 81 01 71 04 40",
        "20 03 20 03 28 02 50 41 87 fd 7e 71 36 02 50",
        "20 03 20 03 2d 00 a2 02 41 fd 01 71 3a 00 a2 02",
        "0b 0b 0b",
        "05",
        // inVehicle == 0:
        "20 09 20 09 28 02 d4 02 41 ff ff d7 fd 7f 71 36 02 d4 02",
        "20 09 28 02 a4 04 41 30 6b 41 04 4b 04 40",
        "20 09 41 00 36 02 90 06",
        "0b",
        "0b"
      ].join(" ")
    )
  },

  // 2B. func 1589 (1202865..1202870): Clear 0x80000 (bDoNotRender) as well as 0x20000 on remote player peds
  {
    start: 1202865,
    end: 1202870,
    bytes: fromHex("41 ff ff d7 fd 7f 71")
  },

  // 2C. func 1589 (1204087..1204116): When remote player is on foot (slot->140 == 0),
  // clean up vehicle if ped->788 == 1 OR ped->784 != 0, and ensure ped->784 = 0 and ped->340 &= -655361.
  {
    start: 1204087,
    end: 1204116,
    bytes: fromHex(
      [
        "20 06 28 02 00 22 05 2d 00 94 06 41 01 46",
        "20 05 28 02 90 06 41 00 47 72",
        "04 40",
        "20 05 41 01 3a 00 94 06",
        "20 05 10 a4 0c",
        "20 07 28 02 00 21 04",
        "0b",
        "20 06 28 02 00 22 05 04 40",
        "20 05 41 00 36 02 90 06",
        "20 05 20 05 28 02 d4 02 41 ff ff d7 fd 7f 71 36 02 d4 02",
        "0b"
      ].join(" ")
    )
  },

  // 2D-1. func 1589 (1204349..1204355): Do not set handbrake or zero velocity on old vehicle `local 1` if local player is driving it
  {
    start: 1204349,
    end: 1204355,
    bytes: fromHex("20 01 28 02 a4 03 10 88 07 46 0d 00 20 01 10 a5 0c 0d 00")
  },

  // 2D-2. func 1589 (1206332..1206338): Do not set handbrake or zero velocity on old vehicle `local 10` if local player is driving it
  {
    start: 1206332,
    end: 1206338,
    bytes: fromHex("20 0a 28 02 a4 03 10 88 07 46 0d 00 20 0a 10 a5 0c 0d 00")
  },

  // 2E. func 1589 (1206461..1206495): When driver conflict (local 13 != 0), place remote peer into constant passenger seat 1
  // instead of calling FindFreePassengerSeat (func 1579) every frame (which caused per-frame seat thrashing)
  {
    start: 1206461,
    end: 1206495,
    bytes: fromHex("20 0d 04 40 20 06 28 02 00 20 01 41 01 10 bc 0c 0c 01 0b")
  },

  // 2D-3. func 1589 (1209124..1209138): On Client, when removing ambient vehicle `local 3` because a player entered it,
  // do not set handbrake or zero velocity if local player is driving `local 3`
  {
    start: 1209124,
    end: 1209138,
    bytes: fromHex(
      "20 03 28 02 a4 03 10 88 07 46 04 40 20 00 21 01 0c 02 0b 20 03 10 a5 0c 04 40 20 00 21 01 0c 02 0b"
    )
  },

  // 2F. func 1589 (1210706..1210711): Clear 0x80000 (bDoNotRender) as well as 0x20000 on ambient NPC peds
  {
    start: 1210706,
    end: 1210711,
    bytes: fromHex("41 ff ff d7 fd 7f 71")
  },

  // 3. func 1596 (PlaceRemotePedIntoVehicle, 1216085..1216107):
  // When local player (local 7) is driver of V (local 1), mask V->80 with -16633 (~(248|16384)) and clear V->290 &= 253
  {
    start: 1216085,
    end: 1216107,
    bytes: fromHex(
      [
        "20 01 28 02 a4 03 20 07 46 20 06 20 07 46 72 04 40",
        "20 01 20 01 28 02 50 41 87 fd 7e 71 36 02 50",
        "20 01 20 01 2d 00 a2 02 41 fd 01 71 3a 00 a2 02",
        "0b 0b"
      ].join(" ")
    )
  },

  // 4. func 1610 (mp_get_local_state, 1218699..1218710):
  // Only report local player as inVehicle (state[16] = 1) when ped->788 == 1 AND ped->548 == 44 (PED_DRIVING),
  // preventing premature seatIndex=1 broadcasts during the 1.5s door-entry animation (PED_ENTER_CAR=50)
  // and preventing stale inVehicle=1 broadcasts during the exit animation (PED_EXIT_CAR=52).
  {
    start: 1218699,
    end: 1218710,
    bytes: fromHex("20 02 2d 00 94 06 41 01 47 20 02 28 02 a4 04 41 2c 47 72 04 40")
  },

  // 5. func 1757 (CPed::EnterCarAnimCallback, 1359444..1359512):
  // - Increment V->456 (m_nNumPassengers) when OBJECTIVE_ENTER_CAR_AS_PASSENGER (14) seats a passenger
  // - Mask V->80 with -16633 (~(248|16384)) instead of -249
  // - Keep V->80 as STATUS_PLAYER (0) whenever ped->812 <= 3 OR V->420 == FindPlayerPed() (call 904)
  {
    start: 1359444,
    end: 1359512,
    bytes: fromHex(
      [
        "22 02 20 00 36 02 00 20 00 20 02 10 c2 07",
        // V->456 = V->456 + 1
        "20 01 20 01 2d 00 c8 03 41 01 6a 3a 00 c8 03",
        "0b",
        // V->80 & -16633
        "20 01 28 02 50 41 87 fd 7e 71 21 02",
        "02 40",
        // if (ped->812 <= 3 || V->420 == call 904)
        "20 00 28 02 ac 06 41 03 4d 20 01 28 02 a4 03 10 88 07 46 72 04 40",
        "20 01 20 02 36 02 50 10 86 02 20 01 10 eb 03 0c 01 0b",
        "20 01 20 02 41 18 72 36 02 50 0b"
      ].join(" ")
    )
  },

  // 6. func 1761 (CPed::LeaveCarAnimCallback, 1364070..1364087):
  // Clear ped->340 &= -655361 (~(0x20000|0x80000)), ped->784 = 0, ped->780 = 0, ped->364 = 0 on car exit completion
  {
    start: 1364070,
    end: 1364087,
    bytes: fromHex(
      [
        "20 01 41 02 36 02 ac 04 0b",
        "20 01 20 01 28 02 d4 02 41 ff ff d7 fd 7f 71 36 02 d4 02",
        "20 01 41 00 36 02 90 06",
        "20 01 41 00 36 02 8c 06",
        "20 01 41 00 36 02 ec 02",
        "20 04 41 10 6a 24 00 0b"
      ].join(" ")
    )
  },

  // 8. func 2274 (CAutomobile::ProcessControl, 1709067..1709075):
  // When call 1573(V) == 0, if V->420 == call 904 and (V->80 & 16632) != 0, clear V->80 &= -16633 and V->290 &= 253
  {
    start: 1709067,
    end: 1709075,
    bytes: fromHex(
      [
        "20 00 10 a5 0c 45 04 40",
        "20 00 28 02 a4 03 10 88 07 46 04 40",
        "20 00 28 02 50 41 f8 81 01 71 04 40",
        "20 00 20 00 28 02 50 41 87 fd 7e 71 36 02 50",
        "20 00 20 00 2d 00 a2 02 41 fd 01 71 3a 00 a2 02",
        "0b 0b 0c 01 0b"
      ].join(" ")
    )
  },

  // 9. func 2419 (CVehicle::RemovePassenger, 1833556..1833573):
  // Guard V->456 decrement so m_nNumPassengers never underflows 0 -> 255
  {
    start: 1833556,
    end: 1833573,
    bytes: fromHex("20 00 2d 00 c8 03 04 40 20 00 20 00 2d 00 c8 03 41 01 6b 3a 00 c8 03 0b 0b 0b")
  }
];

// Parse WASM sections and rebuild Section 10 (Code) with updated function body sizes
let pos = 8;
const sections = [];
while (pos < orig.length) {
  const secStart = pos;
  const id = orig[pos++];
  const { val: secSize, next: bodyStart } = readULEB(orig, pos);
  const secEnd = bodyStart + secSize;
  sections.push({ id, secStart, bodyStart, secEnd });
  pos = secEnd;
}

const outChunks = [orig.subarray(0, 8)];

for (const sec of sections) {
  if (sec.id !== 10) {
    outChunks.push(orig.subarray(sec.secStart, sec.secEnd));
    continue;
  }

  let p = sec.bodyStart;
  const { val: numFuncs, next: funcsStart } = readULEB(orig, p);
  p = funcsStart;

  const funcChunks = [encodeULEB(numFuncs)];
  for (let i = 0; i < numFuncs; i++) {
    const { val: bodySize, next: contentStart } = readULEB(orig, p);
    const contentEnd = contentStart + bodySize;

    // Collect any replacements falling inside [contentStart, contentEnd]
    const funcReps = replacements.filter((r) => r.start >= contentStart && r.end <= contentEnd);
    if (funcReps.length === 0) {
      funcChunks.push(orig.subarray(p, contentEnd));
    } else {
      const parts = [];
      let cursor = contentStart;
      for (const r of funcReps) {
        if (r.start < cursor) {
          throw new Error(`Overlapping replacement at ${r.start}`);
        }
        parts.push(orig.subarray(cursor, r.start));
        parts.push(r.bytes);
        cursor = r.end;
      }
      parts.push(orig.subarray(cursor, contentEnd));
      const newBody = Buffer.concat(parts);
      funcChunks.push(encodeULEB(newBody.length));
      funcChunks.push(newBody);
    }

    p = contentEnd;
  }

  const newCodePayload = Buffer.concat(funcChunks);
  outChunks.push(Buffer.from([10]));
  outChunks.push(encodeULEB(newCodePayload.length));
  outChunks.push(newCodePayload);
}

const patched = Buffer.concat(outChunks);
if (!WebAssembly.validate(patched)) {
  throw new Error("WebAssembly.validate(patched) FAILED!");
}

fs.writeFileSync(wasmPath, patched);
console.log(
  `[patch_coop_bugs] Successfully patched ${wasmPath} (${orig.length} -> ${patched.length} bytes, WebAssembly.validate = true)`
);
