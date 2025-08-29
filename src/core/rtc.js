/**
 * Thin WebRTC dialer for the CLI.
 *
 * Responsibilities:
 * - Pick initiator/responder based on role
 * - Allow passing RTC config (default: { iceServers: [] })
 * - Optional ICE config via env: NT_ICE='[{"urls":"stun:stun.l.google.com:19302"}]'
 * - Minimal debug logging gated by NT_DEBUG
 *
 * Returns the object from @noisytransfer/transport:
 *   - send(msg), onMessage(cb), close()
 *   - getLocalFingerprint(), getRemoteFingerprint(), ...
 */

import { rtcInitiator, rtcResponder } from "@noisytransfer/transport";

const DEBUG = !!process.env.NT_DEBUG;

function defaultRtcConfig() {
  // By default we do not ship any STUN/TURN.
  // Users can set NT_ICE to a JSON array of RTCIceServer entries.
  // Example:
  //   export NT_ICE='[{"urls":"stun:stun.l.google.com:19302"}]'
  //   export NT_ICE='[{"urls":["turn:turn.example.com"],"username":"u","credential":"p"}]'
  let cfg = { iceServers: [] };
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
  const cfg = { ...defaultRtcConfig(), ...rtcConfig };

  if (DEBUG) {
    console.error(
      `[rtc] dialing as ${role}; ICE servers: ${
        (cfg.iceServers && cfg.iceServers.length) ? JSON.stringify(cfg.iceServers) : "[]"
      }`
    );
  }

  const conn =
    role === "initiator"
      ? await rtcInitiator(signal, cfg)
      : await rtcResponder(signal, cfg);

  if (DEBUG) {
    try {
      const fpL = conn.getLocalFingerprint?.();
      const fpR = conn.getRemoteFingerprint?.();
      console.error(
        `[rtc] fingerprints: local=${fpL?.alg || "?"}/${toHex(fpL?.bytes)} remote=${fpR?.alg || "?"}/${toHex(fpR?.bytes)}`
      );
    } catch { /* ignore */ }
  }

  return conn;
}

function toHex(u8) {
  if (!u8 || typeof u8.length !== "number") return "?";
  return Buffer.from(u8).toString("hex").slice(0, 16) + "…";
}
