// src/transfer/pq.js
// PQ/HPKE auth over the WebRTC DataChannel (policy: "rtc") + NoisyStream.
// We add a tiny replay buffer so early auth frames (commit/offer/rcvconfirm/reveal)
// arriving before NoisyAuth attaches are not lost.

import { createAuthSender, createAuthReceiver } from "@noisytransfer/noisyauth";
import { sendFileWithAuth, recvFileWithAuth } from "@noisytransfer/noisystream";
import { suite, genRSAPSS } from "@noisytransfer/crypto";
import { buildMetaHeader, stripMetaHeader } from "./meta-header.js";
import { getLogger } from "../util/logger.js";

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
      getLogger().debug(`${label}: buffer ${t} (sid=${sid ?? "?"})`);
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
        getLogger().debug(`${label}: replay ${t}`);
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
  getLogger().debug("PQ sender: begin auth (SPKI len=", spki.byteLength, ")");

  await new Promise((resolve, reject) => {
    createAuthSender(
      rtc, // uses wrapped transport (replay already attached by caller)
      {
        onSAS: () => {},
        waitConfirm: () => true, // non-interactive
        onDone: () => {
          getLogger().debug("PQ sender: auth done");
          resolve();
        },
        onError: (e) => {
          getLogger().debug(`PQ sender: auth error ${e && e.message ? e.message : e}`);
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
   getLogger().debug("PQ receiver: begin auth (KEM pub len=", kemPub.byteLength, ")");

  await new Promise((resolve, reject) => {
    createAuthReceiver(
      rtc, // uses wrapped transport (replay already attached by caller)
      {
        onSAS: () => {},
        waitConfirm: () => true,
        onDone: () => {
          getLogger().debug("PQ receiver: auth done");
          resolve();
        },
        onError: (e) => {
          getLogger().debug("PQ receiver: auth error", e);
          reject(e);
        },
      },
      { policy: "rtc", sessionId, recvMsg: kemPub }
    );
  });
}

/* ---------------------------------- API ---------------------------------- */
function toAsyncIterable(source) {
  if (source && typeof source[Symbol.asyncIterator] === "function") return source;
  if (source && typeof source.on === "function") {
    return (async function* () { for await (const c of source) yield c instanceof Uint8Array ? c : Buffer.from(c); })();
  }
  throw new Error("pqSend: unsupported source type");
}

function prependHeader(source, headerU8) {
  if (!headerU8) return source;
  const it = toAsyncIterable(source);
  return (async function* () {
    yield headerU8;                  // first frame = header only
    for await (const c of it) yield c;
  })();
}

export async function pqSend(rtcAuth, { sessionId, source, totalBytes, onProgress, name  }) {
  if (!rtcAuth || typeof rtcAuth.send !== "function") throw new Error("pqSend: invalid rtc");
  if (!sessionId) throw new Error("pqSend: sessionId required");
  if (!source) throw new Error("pqSend: source required");

  await handshakeSender(rtcAuth, sessionId);

   // Header chunk (encrypted by auth channel), does not count toward file bytes
  const header = name ? buildMetaHeader(name) : null;
  const sourceWithHeader = prependHeader(source, header);

  getLogger().debug("PQ sender: stream start");
  await sendFileWithAuth({
    tx: rtcAuth,
    sessionId,
    source: sourceWithHeader,
    totalBytes: Number(totalBytes) || 0,
    onProgress,
  });
  getLogger().debug("PQ sender: stream done");

  try {
    if (typeof rtcAuth.flush === "function") await rtcAuth.flush();
  } catch {}
}

function wrapSinkStripMeta(sink) {
  let metaSeen = false;
  return {
    // propagate optional helpers if present
    start: sink.start?.bind(sink),
    info: sink.info?.bind(sink),
    getStats: sink.getStats?.bind(sink),
    close: sink.close?.bind(sink),
    async write(chunk) {
      let u8 = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      if (!metaSeen) {
        metaSeen = true;
        const info = stripMetaHeader(u8);
        if (info) {
          try { sink.info?.({ name: info.name }); } catch {}
          u8 = info.data; // only write the payload
          getLogger().debug("PQ recv META name=", info.name);
       }
      }
      // write remaining bytes (possibly empty if header-only frame)
      if (u8.byteLength) await sink.write(u8);
    },
  };
}


export async function pqRecv(rtc, { sessionId, sink, onProgress }) {
  if (!rtc || typeof rtc.onMessage !== "function") throw new Error("pqRecv: invalid rtc");
  if (!sessionId) throw new Error("pqRecv: sessionId required");
  if (!sink || typeof sink.write !== "function") throw new Error("pqRecv: sink.write required");

  await handshakeReceiver(rtc, sessionId);
  const sinkStripping = wrapSinkStripMeta(sink);

  getLogger().debug("PQ receiver: stream start");
  await recvFileWithAuth({ tx: rtc, sessionId, sink: sinkStripping, onProgress });
  getLogger().debug("PQ receiver: stream done");

  try {
    await sinkStripping.close?.();
  } catch {}
}

