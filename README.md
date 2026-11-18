# Grand Theft Auto III Web — Liberty Net Edition

A browser-native WebAssembly/WebGL2 port of **Grand Theft Auto III** (`re3` + `librw`) featuring **2–4 player online co-op** over **Cloudflare Workers + SQLite Durable Objects + WebRTC P2P DataChannels** and cloud-synced campaign saves.

### [Play Online on Cloudflare Workers](https://gta3web.johansans999.workers.dev)
- **Live Worker URL:** [https://gta3web.johansans999.workers.dev](https://gta3web.johansans999.workers.dev)
- **GitHub Repository:** [https://github.com/GladstoneOG/gta3web](https://github.com/GladstoneOG/gta3web)

---

## Features

- **4-Player Host-and-Peer Co-op:** Create or join Story Co-op or Open Sandbox rooms (`1–4` players) with low-latency WebRTC P2P DataChannels and automatic Cloudflare Durable Object WebSocket relay fallback.
- **Full Liberty City World Sync:** Syncs player peds, custom skins (`0..89`, including Specials like 8-Ball), vehicles, traffic, NPCs, combat, Pay 'n' Spray, car bombs, garages, pickups, Rampages, and passenger seat hopping (`G` key).
- **Cloud Safehouse Saves (Cloudflare SQLite DO):** Register/sign in and save/load full compressed GTA III campaign states in SQLite Durable Objects.
- **Immersive 5-Tab Pause Menu & Top-Middle Liberty Pager:** Bypass single-player boot menus straight into Liberty City while keeping full Settings, Cheats & Vehicle/Pickup Spawner, Identity & Skin switching, Liberty Net Room Browser, and Safehouse Saves accessible anytime (`Tab`, `F1`, `F9`, or hover top-center to wake the auto-hiding Liberty Pager).
- **Cloudflare Workers Free Plan & GitHub Ready:** Every file under `public/` is `< 19 MiB` (`assets/` + `anim/` split cleanly into chunks cached in IndexedDB `gta3web_vfs_v1` with SHA-256 verification).

---

## Controls

| Action | Key / Input |
| :--- | :--- |
| **Move / Drive** | `W` `A` `S` `D` or Arrow Keys |
| **Aim / Look** | Mouse (click canvas for pointer lock) |
| **Fire / Attack** | Left Click or `Ctrl` |
| **Sprint / Handbrake** | `Shift` / `Space` |
| **Enter / Exit Vehicle (Driver)** | `F` or `Enter` |
| **Hop Into Nearby Passenger Seat** | `G` |
| **Liberty Net Pause / Cheats / Saves** | `Tab`, `F1`, `F9`, or `~` |
| **Open Liberty Net Tab Directly** | `M` |

---

## Local Development

```bash
cd gta3web
npm start
# Opens local HTTP + WebSocket Relay + local SQLite/JSON persistence at http://localhost:7777 (or PORT env var)
```

You can override the cloud relay endpoint at runtime via `?relay=http://localhost:7777` or by editing [`public/relay_config.js`](./public/relay_config.js). When accessed on `localhost` / `127.0.0.1`, the client automatically falls back to the local dev server if the remote worker is unreachable.

---

## Deploying to Cloudflare Workers

Pre-configured in [`wrangler.toml`](./wrangler.toml) with Workers Static Assets (`./public`) and the `Gta3RelayHub` SQLite Durable Object (`[[migrations]] tag = "v1"`, compatible with the Cloudflare Workers Free Plan):

```bash
cd gta3web
npx wrangler login
npx wrangler deploy
```

### Cloudflare GitHub Integration (`GladstoneOG/gta3web`)

When connecting `GladstoneOG/gta3web` in **Cloudflare Dashboard -> Workers & Pages -> Import a repository**:
- **Build command:** *(leave empty — WASM and asset packs are prebuilt in `public/`)*
- **Deploy command:** `npx wrangler deploy`
- Workers Static Assets (`public/`), API routes (`/api/*`), WebSocket relay (`/ws`), and `Gta3RelayHub` SQLite Durable Object migrations are applied automatically from [`wrangler.toml`](./wrangler.toml).
