/**
 * Thin WebRTC dialer for the CLI.
 *
 * Responsibilities:
 * - Pick initiator/responder based on role (via dialRtcUntilReady)
 * - Allow passing RTC config (default: { iceServers: [] })
 * - Optional ICE config via env: NT_ICE='[{"urls":"stun:stun.l.google.com:19302"}]'
 * - Minimal debug logging gated by NT_DEBUG
 *
 * Returns the Transport from @noisytransfer/transport:
 *   - send(msg), onMessage(cb), close()
 *   - getLocalFingerprint(), getRemoteFingerprint(), ...
 */

import { dialRtcUntilReady } from "@noisytransfer/transport";
import { ensureRTC } from "../env/rtc-init.js";

const DEBUG = !!process.env.NT_DEBUG;

function defaultRtcConfig() {
  // By default we do not ship any STUN/TURN.
  // Users can set NT_ICE to a JSON array of RTCIceServer entries.
  //   NT_ICE='[{"urls":"stun:stun.l.google.com:19302"}]'
  //   NT_ICE='[{"urls":["turn:turn.example.com"],"username":"u","credential":"p"}]'
  const cfg = { iceServers: [] };
  const raw = process.env.NT_ICE;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) cfg.iceServers = arr;
    } catch (e) {
      if (DEBUG) console.error("NT_ICE parse error:", e?.message || e);
    }
  }
  return cfg;
}

/**
 * Dial an RTC DataChannel using your signaling client.
 * @param {"initiator"|"responder"} role
 * @param {ReturnType<import("./signal.js").createSignalClient>} signal
 * @param {RTCConfiguration} [rtcConfig]
 */
export async function dialRTC(role, signal, rtcConfig = {}) {
  await ensureRTC(); // loads native wrtc in Node

  // Merge env defaults with caller overrides (caller wins).
  const envCfg = defaultRtcConfig();
  const rtcCfg = { ...envCfg, ...rtcConfig };
  if (rtcConfig && "iceServers" in rtcConfig) {
    rtcCfg.iceServers = rtcConfig.iceServers;
  }

  // Use transport’s built-in retry/backoff. Responder passively waits.
  const opts =
    role === "initiator"
      ? { maxAttempts: 4, backoffMs: [200, 500, 1000, 2000] }
      : { maxAttempts: 1, backoffMs: [0] };

  const { tx } = await dialRtcUntilReady({ role, signal, rtcCfg, ...opts });

  if (DEBUG) debugFingerprints(tx, role);
  return tx;
}

function debugFingerprints(tx, role) {
  try {
    let lf, rf;
    try { lf = tx.getLocalFingerprint?.(); } catch {}
    try { rf = tx.getRemoteFingerprint?.(); } catch {}
    if (lf) console.error(`[NT_DEBUG] ${role} local DTLS FP ${lf.alg}: ${toHex(lf.bytes)}`);
    if (rf) console.error(`[NT_DEBUG] ${role} remote DTLS FP ${rf.alg}: ${toHex(rf.bytes)}`);
    if (!lf || !rf) console.error(`[NT_DEBUG] ${role} DTLS fingerprints not available yet (will proceed without blocking)`);
  } catch {}
}

function toHex(u8) {
  if (!u8 || typeof u8.length !== "number") return "?";
  return Buffer.from(u8).toString("hex").slice(0, 32) + "…";
}
