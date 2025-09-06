// src/transfer/pq.js
// PQ/HPKE auth over the WebRTC DataChannel (policy: "rtc") + NoisyStream.
// We add a tiny replay buffer so early auth frames (commit/offer/rcvconfirm/reveal)
// arriving before NoisyAuth attaches are not lost.

import { createAuthSender, createAuthReceiver } from "@noisytransfer/noisyauth";
import { sendFileWithAuth, recvFileWithAuth } from "@noisytransfer/noisystream";
import { suite, genRSAPSS } from "@noisytransfer/crypto";

function waitUp(tx) {
  return new Promise((resolve) => {
    if (tx?.isConnected || tx?.readyState === "open") return resolve();
    const un = tx.onUp?.(() => {
      try {
        un?.();
      } catch {}
      resolve();
    });
    if (!un) queueMicrotask(resolve);
  });
}

// Symbol flag to avoid double-wrapping
const AUTH_WRAP = Symbol.for("nt.authReplayWrapped");

// Buffer early auth frames (commit/offer/reveal/rcvconfirm) for a sessionId,
// replay them once NoisyAuth registers onMessage, then pass-through live frames.
function _withAuthReplay(tx, { sessionId, label = "pq-auth" }) {
  if (tx[AUTH_WRAP]) return tx; // already wrapped
  const AUTH_TYPES = new Set(["commit", "offer", "reveal", "rcvconfirm"]);
  const buf = [];
  const MAX = 32;
  let consumerAttached = false;

  const offTap = tx.onMessage?.((m) => {
    try {
      if (!m || typeof m !== "object") return;
      const t =
        m.type ||
        (m.offer && "offer") ||
        (m.reveal && "reveal") ||
        (m.rcvconfirm && "rcvconfirm") ||
        null;
      if (!t || !AUTH_TYPES.has(t)) return;
      const sid = m.sessionId;
      if (sid && sessionId && sid !== sessionId) return;
      if (consumerAttached) return;
      buf.push({ t, m });
      if (buf.length > MAX) buf.shift();
      if (process.env.NT_DEBUG)
        console.error(`[NT_DEBUG] ${label}: buffer ${t} (sid=${sid ?? "?"})`);
    } catch {}
  });

  const wrapped = {
    [AUTH_WRAP]: true,

    get isConnected() {
      return tx.isConnected ?? tx.isUp ?? true;
    },
    onUp(cb) {
      return tx.onUp?.(cb) || (() => {});
    },
    onDown(cb) {
      return tx.onDown?.(cb) || (() => {});
    },
    onClose(cb) {
      return tx.onClose?.(cb) || (() => {});
    },
    getLocalFingerprint() {
      return tx.getLocalFingerprint?.();
    },
    getRemoteFingerprint() {
      return tx.getRemoteFingerprint?.();
    },
    flush: tx.flush?.bind(tx),
    close: tx.close?.bind(tx),

    send(m) {
      return tx.send(m);
    }, // outbound unchanged

    onMessage(cb) {
      consumerAttached = true;
      // 1) replay buffered frames synchronously in order
      for (const { t, m } of buf) {
        if (process.env.NT_DEBUG) console.error(`[NT_DEBUG] ${label}: replay ${t}`);
        try {
          cb(m);
        } catch {}
      }
      buf.length = 0;
      // 2) then pass-through live frames
      return tx.onMessage((m) => {
        try {
          cb(m);
        } catch {}
      });
    },
  };
  return wrapped;
}

/** Exported so callers can attach the replay wrapper immediately after dialRTC */
export function wrapAuthDC(rtc, { sessionId, label }) {
  return _withAuthReplay(rtc, { sessionId, label });
}

/* ---------------------------- internal handshakes --------------------------- */

async function handshakeSender(rtc, sessionId) {
  await waitUp(rtc);

  // Sender publishes SPKI bytes (verification key)
  const { verificationKey: spki } = await genRSAPSS();
  if (process.env.NT_DEBUG)
    console.error("[NT_DEBUG] PQ sender: begin auth (SPKI len=", spki.byteLength, ")");

  await new Promise((resolve, reject) => {
    createAuthSender(
      rtc, // uses wrapped transport (replay already attached by caller)
      {
        onSAS: () => {},
        waitConfirm: () => true, // non-interactive
        onDone: () => {
          if (process.env.NT_DEBUG) console.error("[NT_DEBUG] PQ sender: auth done");
          resolve();
        },
        onError: (e) => {
          if (process.env.NT_DEBUG) console.error("[NT_DEBUG] PQ sender: auth error", e);
          reject(e);
        },
      },
      { policy: "rtc", sessionId, sendMsg: spki }
    );
  });
}

async function handshakeReceiver(rtc, sessionId) {
  await waitUp(rtc);

  // Receiver publishes serialized KEM public key
  const kemKeyPair = await suite.kem.generateKeyPair();
  const kemPub = new Uint8Array(await suite.kem.serializePublicKey(kemKeyPair.publicKey));
  if (process.env.NT_DEBUG)
    console.error("[NT_DEBUG] PQ receiver: begin auth (KEM pub len=", kemPub.byteLength, ")");

  await new Promise((resolve, reject) => {
    createAuthReceiver(
      rtc, // uses wrapped transport (replay already attached by caller)
      {
        onSAS: () => {},
        waitConfirm: () => true,
        onDone: () => {
          if (process.env.NT_DEBUG) console.error("[NT_DEBUG] PQ receiver: auth done");
          resolve();
        },
        onError: (e) => {
          if (process.env.NT_DEBUG) console.error("[NT_DEBUG] PQ receiver: auth error", e);
          reject(e);
        },
      },
      { policy: "rtc", sessionId, recvMsg: kemPub }
    );
  });
}

/* ---------------------------------- API ---------------------------------- */

export async function pqSend(rtc, { sessionId, source, totalBytes, onProgress }) {
  if (!rtc || typeof rtc.send !== "function") throw new Error("pqSend: invalid rtc");
  if (!sessionId) throw new Error("pqSend: sessionId required");
  if (!source) throw new Error("pqSend: source required");

  await handshakeSender(rtc, sessionId);

  if (process.env.NT_DEBUG) console.error("[NT_DEBUG] PQ sender: stream start");
  await sendFileWithAuth({
    tx: rtc,
    sessionId,
    source,
    totalBytes: Number(totalBytes) || 0,
    onProgress,
  });
  if (process.env.NT_DEBUG) console.error("[NT_DEBUG] PQ sender: stream done");

  try {
    if (typeof rtc.flush === "function") await rtc.flush();
  } catch {}
}

export async function pqRecv(rtc, { sessionId, sink, onProgress }) {
  if (!rtc || typeof rtc.onMessage !== "function") throw new Error("pqRecv: invalid rtc");
  if (!sessionId) throw new Error("pqRecv: sessionId required");
  if (!sink || typeof sink.write !== "function") throw new Error("pqRecv: sink.write required");

  await handshakeReceiver(rtc, sessionId);

  if (process.env.NT_DEBUG) console.error("[NT_DEBUG] PQ receiver: stream start");
  await recvFileWithAuth({ tx: rtc, sessionId, sink, onProgress });
  if (process.env.NT_DEBUG) console.error("[NT_DEBUG] PQ receiver: stream done");

  try {
    await sink.close?.();
  } catch {}
}
