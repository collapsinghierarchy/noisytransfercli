// src/env/rtc-init.js
// Initialize a WebRTC backend for Node CLIs and expose the canonical globals.
// Returns a short backend name for logging, e.g. "@roamhq/wrtc" or "embedded-asset".

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { getLogger } from "../util/logger.js";

const require = createRequire(import.meta.url);

function setGlobals(wrtc) {
  globalThis.RTCPeerConnection ??= wrtc.RTCPeerConnection;
  globalThis.RTCIceCandidate ??= wrtc.RTCIceCandidate;
  globalThis.RTCSessionDescription ??= wrtc.RTCSessionDescription;
  if (wrtc.RTCDataChannel) globalThis.RTCDataChannel ??= wrtc.RTCDataChannel;

  // EventTarget-ish shim for addEventListener/removeEventListener
  try {
    const ensureET = (Ctor) => {
      if (!Ctor || typeof Ctor.prototype?.addEventListener === "function") return;
      const P = Ctor.prototype;
      P.addEventListener = function (type, fn) {
        if (!this.__listeners)
          Object.defineProperty(this, "__listeners", { value: Object.create(null) });
        (this.__listeners[type] || (this.__listeners[type] = new Set())).add(fn);
        const prop = "on" + type;
        if (!this[prop]) {
          this[prop] = (ev) => {
            const ls = this.__listeners?.[type];
            if (ls) for (const f of Array.from(ls)) { try { f(ev); } catch {} }
          };
        }
      };
      P.removeEventListener = function (type, fn) {
        this.__listeners?.[type]?.delete(fn);
      };
    };
    ensureET(globalThis.RTCPeerConnection);
    if (globalThis.RTCDataChannel) ensureET(globalThis.RTCDataChannel);
  } catch {}
}

function moduleDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveEmbeddedPath() {
  const plat = process.platform; // 'linux' | 'darwin' | 'win32'
  const arch = process.arch;     // 'x64' | 'arm64' | ...
  const tag =
    plat === "linux"  && arch === "x64"   ? "linux-x64"   :
    plat === "linux"  && arch === "arm64" ? "linux-arm64" :
    plat === "darwin" && arch === "x64"   ? "darwin-x64"  :
    plat === "darwin" && arch === "arm64" ? "darwin-arm64":
    plat === "win32"  && arch === "x64"   ? "win32-x64"   :
    `${plat}-${arch}`;

  // When packaged with `pkg`, assets live next to the executable.
  // When running from npm (ESM), resolve relative to the built file:
  //   dist/env/rtc-init.js  ->  dist/assets/native/<tag>/wrtc.node
  const base = process.pkg
    ? path.dirname(process.execPath)
    : path.join(moduleDir(), ".."); // go up from dist/env -> dist

  const p = path.join(base, "assets", "native", tag, "wrtc.node");
  return fs.existsSync(p) ? p : null;
}

export function ensureRTC() {
  // If already initialized elsewhere, keep it.
  if (globalThis.RTCPeerConnection) return "preinitialized";

  // Prefer the wrtc package if present (works in dev & npm installs)
  try {
    // ESM-friendly require
    const wrtc = require("@roamhq/wrtc");
    setGlobals(wrtc);
    return "@roamhq/wrtc";
  } catch (e) {
    getLogger().debug("wrtc package load failed:", e?.message || e);
  }

  // Fallback: embedded native addon (your build scripts copy it to dist/assets/native/...).
  const nativePath = resolveEmbeddedPath();
  if (nativePath) {
    try {
      const wrtc = require(nativePath); // .node addon
      setGlobals(wrtc);
      return "embedded-asset";
    } catch (e) {
      getLogger().debug("embedded wrtc load failed:", e?.message || e);
    }
  }

  throw new Error(
    "No WebRTC backend initialized: tried @roamhq/wrtc and embedded .node. " +
    "Install @roamhq/wrtc or bundle a native asset at dist/assets/native/<platform-arch>/wrtc.node"
  );
}
