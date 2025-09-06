// src/env/rtc-init.js
// Initialize a WebRTC backend for Node CLIs and expose the canonical globals.
// Returns a short backend name for logging, e.g. "@roamhq/wrtc" or "embedded-asset".

import path from "node:path";
import fs from "node:fs";

function setGlobals(wrtc) {
  // Map the backend into the global WebRTC surface the protocol expects.
  globalThis.RTCPeerConnection ??= wrtc.RTCPeerConnection;
  globalThis.RTCIceCandidate ??= wrtc.RTCIceCandidate;
  globalThis.RTCSessionDescription ??= wrtc.RTCSessionDescription;
  // Some builds also expose RTCDataChannel as a class; if so, surface it.
  if (wrtc.RTCDataChannel) {
    globalThis.RTCDataChannel ??= wrtc.RTCDataChannel;
  }

  // --- EventTarget shim (for embedded/native builds that lack addEventListener)
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
            if (ls)
              for (const f of Array.from(ls)) {
                try {
                  f(ev);
                } catch {}
              }
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

function resolveEmbeddedPath() {
  const plat = process.platform; // 'linux' | 'darwin' | 'win32'
  const arch = process.arch; // 'x64' | 'arm64' | ...
  const tag =
    plat === "linux" && arch === "x64"
      ? "linux-x64"
      : plat === "linux" && arch === "arm64"
        ? "linux-arm64"
        : plat === "darwin" && arch === "x64"
          ? "darwin-x64"
          : plat === "darwin" && arch === "arm64"
            ? "darwin-arm64"
            : plat === "win32" && arch === "x64"
              ? "win32-x64"
              : `${plat}-${arch}`;

  // When packaged with pkg, assets live next to process.execPath.
  const base = process.pkg
    ? path.dirname(process.execPath)
    : path.join(__dirname, "..", "..", "dist");
  const p = path.join(base, "assets", "native", tag, "wrtc.node");
  return fs.existsSync(p) ? p : null;
}

export function ensureRTC() {
  // If another part already set a backend, keep it.
  if (globalThis.RTCPeerConnection) return "preinitialized";

  // Try the JS wrapper package first (best compatibility).
  try {
    // eslint-disable-next-line n/no-missing-require
    const wrtc = require("@roamhq/wrtc"); // works both in dev & when externalized for pkg
    setGlobals(wrtc);
    return "@roamhq/wrtc";
  } catch {
    // fall through
  }

  // Fallback to an embedded native addon (shipped with your binary).
  const nativePath = resolveEmbeddedPath();
  if (nativePath) {
    try {
      // eslint-disable-next-line n/no-missing-require
      const wrtc = require(nativePath); // loads the .node addon directly
      setGlobals(wrtc);
      return "embedded-asset";
    } catch (e) {
      if (process.env.NT_DEBUG)
        console.error("[NT_DEBUG] embedded wrtc load failed:", e?.message || e);
    }
  }

  // If we get here, no backend was installed.
  throw new Error(
    "No WebRTC backend initialized: tried @roamhq/wrtc and embedded .node. " +
      "Install @roamhq/wrtc or bundle a native asset at dist/assets/native/<platform-arch>/wrtc.node"
  );
}
