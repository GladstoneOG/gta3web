/**
 * Grand Theft Auto III Web — Cloud Relay & Worker Configuration
 * =============================================================
 *
 * Production Cloudflare Worker URL:
 *   https://gta3web.johansans999.workers.dev
 *
 * When served from Cloudflare Workers (https://gta3web.johansans999.workers.dev)
 * or locally via `node server.js`, the client automatically uses same-origin
 * `/api/ws` and `/api/rooms`. When opened from an external static host or file://,
 * or overridden via `?relay=<url>`, `window.GTA3_DEFAULT_RELAY` is used.
 */
window.GTA3_DEFAULT_RELAY = window.GTA3_DEFAULT_RELAY || "https://gta3web.johansans999.workers.dev";
window.GTA3_RELAY_URL = window.GTA3_RELAY_URL || "";
