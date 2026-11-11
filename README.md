# 🚓 Grand Theft Auto III Web — 8-Player Multiplayer & Sandbox Trainer

A full-featured, zero-dependency browser port of **Grand Theft Auto III** (powered by the reverse-engineered `re3` WebAssembly engine), featuring an **8-Player Online Multiplayer Hub**, an interactive **6-Tab Sandbox & Trainer Spawner**, and instant **Cloudflare Workers + Durable Objects** deployment.

### 🎮 [Play Online Now](https://gta3web.johansans999.workers.dev)
**Live Link:** [https://gta3web.johansans999.workers.dev](https://gta3web.johansans999.workers.dev)

---

## 🌟 Key Features

1. **8-Player Online Co-op & Freeroam Relay**:
   - Up to 8 players per room (1 Host `peerId = 1` + 7 Clients `peerId = 2..8`).
   - Clean 4-byte binary framing protocol with direct peer-to-peer fast broadcast (`channel = 2`) for 25 Hz movement, animation, vitals, and vehicle synchronization.
   - **Direct WebRTC P2P DataChannels (`gta3-p2p`)**: Automatically establishes peer-to-peer unordered DataChannels between connected players with automatic fallback to Cloudflare Durable Object WebSocket relay.
   - Global low-latency relay via Cloudflare SQLite-backed Durable Objects (`GTA3RelayHub`) and zero-dependency native Node.js relay (`server.js`).
   - Resilient Host migration: if the Room Host disconnects, the oldest connected client is automatically promoted to Host without dropping the session.
   - One-click Invite Link generation (`?room=XXXX`) for instant multiplayer joining.

2. **Full Sandbox Map Unlock & Trainer Menu (`F3`)**:
   - **`🔓 Unlock All Map`**: Programmatically unlocks all three islands (**Portland**, **Staunton Island**, and **Shoreside Vale**), repairs and rebuilds the damaged spans of **Callahan Bridge**, opens the **Porter Tunnel** and subway barricades, and enables full traffic/ped streaming across Liberty City.
   - **👤 Character Skins**: Switch between all 83 pedestrian models (`0..82`), including Claude, LCPD Patrol Cops, SWAT Officers, FBI Agents, Army Soldiers, Leone Mafia, Triads, Diablos, Yakuza, Yardies, Colombian Cartels, 8-Ball, Catalina, and Salvatore Leone.
   - **🚗 Complete Vehicle Spawner**: Search and spawn all **61 GTA III vehicles** (`90..150`) with custom paint colors and optional auto-warp into the driver seat (featuring the Cheetah, Infernus, Banshee, Stinger, Mafia Sentinel, Rhino Tank, Dodo airplane, Speeder boat, and Borgnine Taxi).
   - **🎒 Weapons & Ammo**: Instant 9999 ammo pack and individual weapon spawning for all 12 weapons (Baseball Bat, Colt .45, Micro Uzi, Shotgun, AK-47, M16, Sniper Rifle, Rocket Launcher, Flamethrower, Molotovs, Grenades, and Remote Detonator).
   - **📍 18 Iconic Teleport Locations**: One-click teleportation across all three boroughs, plus dynamic **Teleport to Connected Player** functionality.
   - **⚡ Cheats & World Controls**: Live toggles for God Mode, Infinite Ammo, Never Wanted, Flying Cars, Tank Smash Mode, Super Sprint, plus synchronized weather (Sunny, Cloudy, Stormy, Foggy) and time-of-day presets.

3. **High-Performance Asset Pipeline & Offline Cache**:
   - Chunked & gzip-compressed asset slices (`<20 MiB` each) complying with Cloudflare's 25 MiB file limit.
   - Persistent browser caching via IndexedDB (`gta3web-cache-v1`) for instant subsequent boot times.
   - Lazy background loading for all 10 in-car radio stations (`HEAD.mp3`, `CLASS.mp3`, `KJAH.mp3`, `RISE.mp3`, `LIPS.mp3`, `GAME.mp3`, `MSX.mp3`, `FLASH.mp3`, `CHAT.mp3`, and `police.mp3`).
   - Automatic save-game persistence to browser storage (`window.Re3Saves` mounted on `IDBFS`).

---

## 🕹️ Controls & Keybindings

| Key | Action |
| :--- | :--- |
| **`W`, `A`, `S`, `D`** | Move Claude / Steer Vehicle |
| **`Left Click` / `Ctrl`** | Attack / Fire Active Weapon |
| **`Mouse Move`** | 3D Camera Look (Click canvas to lock pointer) |
| **`Space`** | Jump / Handbrake |
| **`Shift`** | Sprint |
| **`F` / `Enter`** | Enter / Exit Vehicle |
| **`C`** | Change Camera View |
| **`Q` / `E`** | Look Left / Look Right in vehicle |
| **`F2`** | Toggle Top Command Bar |
| **`F3`** | Toggle Sandbox Trainer & Vehicle Spawner (Releases mouse) |
| **`T`** | Open In-Game Room Chat |
| **`Escape`** | Close Open Menus / Release Pointer Lock |

---

## 🚀 Quick Start (Local Development)

The repository has **zero external dependencies** and runs out of the box with native Node.js:

```bash
# Clone or navigate to the repository
cd gta3web

# Start local server on port 8080 (serves static assets + WebSocket relay)
npm start
# or: node server.js
```

Open [http://localhost:8080](http://localhost:8080) in any modern browser (Chrome, Firefox, Edge, Safari).

---

## ☁️ Cloudflare Workers Deployment

The project is preconfigured with `wrangler.toml` for 100% serverless deployment on the **Cloudflare Workers Free Plan** using SQLite-backed Durable Objects:

```bash
# Preview on local Cloudflare Workers runtime
npm run cf:dev
# or: npx wrangler dev

# Deploy live to Cloudflare Workers
npm run cf:deploy
# or: npx wrangler deploy
```

### Cloudflare Configuration (`wrangler.toml`)
- **Live Worker URL**: `https://gta3web.johansans999.workers.dev`
- **Assets binding**: `./public` directory.
- **Worker routing**: `/api/*` and `/ws` handled by worker before static assets.
- **Durable Object binding**: `RELAY_HUB` bound to `GTA3RelayHub`.
- **Free Plan Migration**: `[[migrations]] tag = "v1", new_sqlite_classes = ["GTA3RelayHub"]`.

### Connecting GitHub (`https://github.com/GladstoneOG/gta3web`) to Cloudflare Workers Builds
If you connect the GitHub repository in **Cloudflare Dashboard** -> **Workers & Pages** -> **Create application** -> **Import a repository** -> `GladstoneOG/gta3web`:
- **Build command**: *(leave empty, or `echo "Prebuilt static assets"`)*
- **Deploy command**: `npx wrangler deploy`
- Workers Static Assets (`./public`) and the `GTA3RelayHub` SQLite Durable Object are deployed automatically from `wrangler.toml`.

---

## 📡 Multiplayer Protocol Specification

Multiplayer communication uses a compact 4-byte header:
```
[frameType (1B), (peerId >> 8) & 0xff (1B), peerId & 0xff (1B), channel (1B), ...payload]
```

### Frame Types (Transport Header)
- `0x01` (`FRAME_DATA`): Payload data. When sent on `channel = 2`, the relay performs zero-copy peer-to-peer fast broadcast to all other peers in the room.
- `0x02` (`FRAME_PEER_CONNECTED`): Notifies peers of newly joined players and synchronizes player names.
- `0x03` (`FRAME_PEER_DISCONNECTED`): Notifies peers when a player leaves; automatically initiates Host migration if `peerId = 1` disconnects.
- `0x04` (`FRAME_KICK_PEER`): Host kick command.
- `0x05` (`FRAME_ROOM_INFO`): Room metadata broadcast (JSON payload containing active players, island, mode, weather).
- `0x06` (`FRAME_HOST_ASSIGNED`): `[0x06, portHi, portLo, assignedPeerId]` sent immediately upon connection.
- `0x07` (`FRAME_REJECTED`): Rejection notice with UTF-8 reason string.

### Packet Types (Game Payload)
- `0x10` (`PKT_PLAYER_STATE`): 28-float synchronization vector (positions, velocities, angles, animations, vehicle state, vitals) transmitted at 25 Hz.
- `0x11` (`PKT_WORLD_SYNC`): Synchronized weather condition and time of day.
- `0x12` (`PKT_VEHICLE_SPAWN`): Spawned vehicle model ID, primary and secondary colors.
- `0x13` (`PKT_CHAT`): Room chat message broadcast.
- `0x14` (`PKT_PVP_HIT`): Target peer ID, damage amount, and weapon type.
- `0x30` (`PKT_RTC_SIGNAL`): WebRTC SDP offer, answer, and ICE candidate exchange for direct P2P mesh.

---

## 📁 Repository Structure

```
gta3web/
├── cloudflare_worker.js     # Cloudflare Worker + GTA3RelayHub Durable Object
├── server.js                # Zero-dependency Node.js HTTP/Range + WebSocket relay server
├── wrangler.toml            # Cloudflare deployment & SQLite DO configuration
├── package.json             # NPM package scripts (npm start, cf:deploy)
├── .gitignore               # Excludes build toolchains (.emsdk, re3-wasm, node_modules)
├── README.md                # Technical overview and developer documentation
└── public/
    ├── index.html           # Full game UI, 6-tab trainer, asset loader, 25 Hz net sync
    ├── relay_config.js      # Production Worker URL (https://gta3web.johansans999.workers.dev)
    ├── engine/
    │   ├── re3_wasm.js      # Emscripten JS runtime
    │   └── re3_wasm.wasm    # Compiled re3 WebAssembly engine
    ├── chunks/
    │   ├── manifest.json    # Asset chunk offsets and raw sizes
    │   ├── gta3_base.pack.gz# 171 core data & configuration files (10.28 MB)
    │   ├── gta3_img.part*.gz# 5 slices of 3D models and textures (models/gta3.img)
    │   └── sfx_raw.part*.gz # 5 slices of sound effects (audio/sfx.RAW)
    └── audio/
        ├── City.mp3         # Ambient city audio
        ├── Water.mp3        # Ambient water audio
        └── *.mp3            # 10 in-car radio stations (HEAD, FLASH, CHAT, MSX, etc.)
```

---

## ⚖️ License & Acknowledgements

- **re3**: Original reverse-engineered Grand Theft Auto III project by the re3 team.
- **Assets**: Grand Theft Auto III game assets are the intellectual property of Rockstar Games and Take-Two Interactive.
- **Web Port & Multiplayer Relay**: Licensed under the MIT License.
