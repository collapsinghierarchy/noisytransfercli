// src/env/node-polyfills.js
import { webcrypto } from "node:crypto";

// WebCrypto in Node
globalThis.crypto ??= webcrypto;

// NOTE: After bundling to CJS with esbuild, `require` is available.
// We avoid import.meta/createRequire and any top-level await.

const req = (typeof require !== "undefined") ? require : null;

// WebRTC shims (Node)
try {
  if (req) {
    const wrtc = req("@roamhq/wrtc");
    globalThis.RTCPeerConnection     ??= wrtc.RTCPeerConnection;
    globalThis.RTCIceCandidate       ??= wrtc.RTCIceCandidate;
    globalThis.RTCSessionDescription ??= wrtc.RTCSessionDescription;
  }
} catch { /* optional */ }

// WebSocket shim (Node)
try {
  if (req) {
    const WS = req("ws");
    globalThis.WebSocket = globalThis.WebSocket || WS;
  }
} catch { /* optional */ }

// Optional SOCKS5 for WebSocket dialing (if you route signaling via Tor/proxy)
if (process.env.NT_SOCKS5 && req) {
  try {
    const { SocksProxyAgent } = req("socks-proxy-agent");
    globalThis.__NT_SOCKS_AGENT__ = new SocksProxyAgent(
      process.env.NT_SOCKS5.startsWith("socks")
        ? process.env.NT_SOCKS5
        : `socks5://${process.env.NT_SOCKS5}`
    );
  } catch { /* optional */ }
}
