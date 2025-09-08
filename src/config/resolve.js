// src/config/resolve.js

// Dev-friendly defaults that work with scripts/ws-broker.js
export const DEV_DEFAULT_RELAY = process.env.NT_DEFAULT_RELAY || "ws://127.0.0.1:1234/ws";
export const DEV_DEFAULT_API = process.env.NT_DEFAULT_API || "http://127.0.0.1:1234";

export function resolveCfg(opts = {}) {
  // Priority: CLI flags > explicit env > dev defaults
  const relay   = opts.relay  || process.env.NT_RELAY     || DEV_DEFAULT_RELAY;
  const api     = opts.api    || process.env.NT_API_BASE  || DEV_DEFAULT_API;
  const ttlSec  = Number(process.env.NT_CODE_TTL_SEC || 600);
  const headers = opts.headers || undefined; // JSON-parsed upstream
  return { relay, api, ttlSec, headers };
}

export function assertRelay(relay) {
  // Basic sanity: require ws:// or wss:// (the default satisfies this)
  if (!relay || !/^wss?:\/\//.test(relay)) {
    throw new Error(
      `NoisyTransfer: invalid relay URL "${relay}". Expected ws:// or wss:// (e.g. ${DEV_DEFAULT_RELAY}).`
    );
  }
}
