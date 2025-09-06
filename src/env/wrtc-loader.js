// src/env/wrtc-loader.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Detect whether we truly have import.meta.url (ESM) or we're CJS after bundling
const hasImportMetaUrl = typeof import.meta !== "undefined" && import.meta && import.meta.url;

// A require() that works in both worlds
const requireCJS = hasImportMetaUrl
  ? createRequire(import.meta.url)
  : // in CJS bundles, `require` exists; last fallback gives createRequire *some* filename
    typeof require !== "undefined"
    ? require
    : createRequire(path.join(process.cwd(), "noop.js"));

// A __dirname-like path that works in both worlds
const __dirnameLike = hasImportMetaUrl
  ? path.dirname(fileURLToPath(import.meta.url))
  : typeof __dirname !== "undefined"
    ? __dirname
    : process.cwd();

function setGlobals(wrtc) {
  globalThis.RTCPeerConnection ??= wrtc.RTCPeerConnection;
  globalThis.RTCIceCandidate ??= wrtc.RTCIceCandidate;
  globalThis.RTCSessionDescription ??= wrtc.RTCSessionDescription;

  // Some native builds don’t expose a JS EventTarget API on PC/DC.
  // Add a minimal polyfill compatible with the protocol’s usage.
  try {
    const PC = wrtc.RTCPeerConnection;
    const DC = wrtc.RTCDataChannel || globalThis.RTCDataChannel; // some builds expose it
    const ensureET = (Ctor) => {
      if (!Ctor || typeof Ctor.prototype?.addEventListener === "function") return;
      const proto = Ctor.prototype;
      proto.addEventListener = function (type, fn) {
        // Lazy-init a per-instance listener bag
        if (!this.__listeners)
          Object.defineProperty(this, "__listeners", {
            value: Object.create(null),
            enumerable: false,
          });
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
      proto.removeEventListener = function (type, fn) {
        this.__listeners?.[type]?.delete(fn);
      };
    };
    ensureET(PC);
    if (DC) {
      ensureET(DC);
      globalThis.RTCDataChannel ??= DC;
    }
  } catch {}
}
