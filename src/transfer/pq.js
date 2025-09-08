// src/transfer/pq.js
import { createAuthSender, createAuthReceiver } from "@noisytransfer/noisyauth";
import { sendFileWithAuth, recvFileWithAuth } from "@noisytransfer/noisystream";
import { suite, genRSAPSS } from "@noisytransfer/crypto";
import { buildMetaHeader, stripMetaHeader } from "./meta-header.js";
import { getLogger } from "../util/logger.js";
import readline from "node:readline";

/* ------------------------------- helpers -------------------------------- */

function waitUp(tx) {
  return new Promise((resolve) => {
    if (tx?.isConnected || tx?.readyState === "open") return resolve();
    const un = tx.onUp?.(() => { try { un?.(); } catch {} resolve(); });
    if (!un) queueMicrotask(resolve);
  });
}

async function confirmSAS({ role, sas, assumeYes }) {
  const tag = role === "A" ? "[SAS A]" : "[SAS B]";
  try { process.stderr.write(`${tag} ${sas}\n`); } catch {}
  if (assumeYes) return;

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("SAS confirmation requires a TTY; run with -y to auto-accept.");
  }
  const prompt = role === "A"
    ? "A: Do the SAS match on both sides? [y/N] "
    : "B: Do the SAS match on both sides? [y/N] ";
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((res) => rl.question(prompt, (a) => { rl.close(); res(String(a).trim().toLowerCase()); }));
  if (!(answer === "y" || answer === "yes")) {
    throw new Error("Aborted by user");
  }
}

/* ----------------------- auth replay wrapper (unchanged) ----------------- */

const AUTH_WRAP = Symbol.for("nt.authReplayWrapped");

function _withAuthReplay(tx, { sessionId, label = "pq-auth" }) {
  if (tx[AUTH_WRAP]) return tx;
  const AUTH_TYPES = new Set(["commit", "offer", "reveal", "rcvconfirm"]);
  const buf = [];
  const MAX = 32;
  let consumerAttached = false;

  const offTap = tx.onMessage?.((m) => {
    try {
      if (!m || typeof m !== "object") return;
      const t = m.type || (m.offer && "offer") || (m.reveal && "reveal") || (m.rcvconfirm && "rcvconfirm") || null;
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
    get isConnected() { return tx.isConnected ?? tx.isUp ?? true; },
    onUp(cb)    { return tx.onUp?.(cb)    || (() => {}); },
    onDown(cb)  { return tx.onDown?.(cb)  || (() => {}); },
    onClose(cb) { return tx.onClose?.(cb) || (() => {}); },
    getLocalFingerprint:  tx.getLocalFingerprint?.bind(tx),
    getRemoteFingerprint: tx.getRemoteFingerprint?.bind(tx),
    flush: tx.flush?.bind(tx),
    close: tx.close?.bind(tx),
    send(m) { return tx.send(m); },
    onMessage(cb) {
      consumerAttached = true;
      for (const { t, m } of buf) {
        getLogger().debug(`${label}: replay ${t}`);
        try { cb(m); } catch {}
      }
      buf.length = 0;
      return tx.onMessage((m) => { try { cb(m); } catch {} });
    },
  };
  return wrapped;
}

export function wrapAuthDC(rtc, { sessionId, label }) {
  return _withAuthReplay(rtc, { sessionId, label });
}

/* ------------------------------ handshakes ------------------------------- */

async function handshakeSender(rtc, sessionId, { assumeYes } = {}) {
  await waitUp(rtc);
  const { verificationKey: spki } = await genRSAPSS();
  getLogger().debug("PQ sender: begin auth (SPKI len=", spki.byteLength, ")");

  await new Promise((resolve, reject) => {
    createAuthSender(
      rtc,
      {
        // Show SAS and wait for user unless -y
        onSAS: async (sas) => {
          getLogger().debug(`sender: computed SAS ${sas}`);
          await confirmSAS({ role: "A", sas, assumeYes });
        },
        // After onSAS resolves, allow confirm
        waitConfirm: () => true,
        onDone: () => { getLogger().debug("PQ sender: auth done"); resolve(); },
        onError: (e) => { getLogger().debug(`PQ sender: auth error ${e?.message || e}`); reject(e); },
      },
      { policy: "rtc", sessionId, sendMsg: spki }
    );
  });
}

async function handshakeReceiver(rtc, sessionId, { assumeYes } = {}) {
  await waitUp(rtc);
  const kemKeyPair = await suite.kem.generateKeyPair();
  const kemPub = new Uint8Array(await suite.kem.serializePublicKey(kemKeyPair.publicKey));
  getLogger().debug("PQ receiver: begin auth (KEM pub len=", kemPub.byteLength, ")");

  await new Promise((resolve, reject) => {
    createAuthReceiver(
      rtc,
      {
        onSAS: async (sas) => {
          getLogger().debug(`receiver: computed SAS ${sas}`);
          await confirmSAS({ role: "B", sas, assumeYes });
        },
        waitConfirm: () => true,
        onDone: () => { getLogger().debug("PQ receiver: auth done"); resolve(); },
        onError: (e) => { getLogger().debug(`PQ receiver: auth error ${e?.message || e}`); reject(e); },
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
    yield headerU8;
    for await (const c of it) yield c;
  })();
}

export async function pqSend(rtcAuth, { sessionId, source, totalBytes, onProgress, name, assumeYes }) {
  if (!rtcAuth || typeof rtcAuth.send !== "function") throw new Error("pqSend: invalid rtc");
  if (!sessionId) throw new Error("pqSend: sessionId required");
  if (!source) throw new Error("pqSend: source required");

  await handshakeSender(rtcAuth, sessionId, { assumeYes });

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

  try { if (typeof rtcAuth.flush === "function") await rtcAuth.flush(); } catch {}
}

function wrapSinkStripMeta(sink) {
  let metaSeen = false;
  return {
    start: sink.start?.bind(sink),
    info:  sink.info?.bind(sink),
    getStats: sink.getStats?.bind(sink),
    close: sink.close?.bind(sink),
    async write(chunk) {
      let u8 = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      if (!metaSeen) {
        metaSeen = true;
        const info = stripMetaHeader(u8);
        if (info) {
          try { sink.info?.({ name: info.name }); } catch {}
          u8 = info.data;
          getLogger().debug("PQ recv META name=", info.name);
        }
      }
      if (u8.byteLength) await sink.write(u8);
    },
  };
}

export async function pqRecv(rtc, { sessionId, sink, onProgress, assumeYes }) {
  if (!rtc || typeof rtc.onMessage !== "function") throw new Error("pqRecv: invalid rtc");
  if (!sessionId) throw new Error("pqRecv: sessionId required");
  if (!sink || typeof sink.write !== "function") throw new Error("pqRecv: sink.write required");

  await handshakeReceiver(rtc, sessionId, { assumeYes });
  const sinkStripping = wrapSinkStripMeta(sink);

  getLogger().debug("PQ receiver: stream start");
  await recvFileWithAuth({ tx: rtc, sessionId, sink: sinkStripping, onProgress });
  getLogger().debug("PQ receiver: stream done");

  try { await sinkStripping.close?.(); } catch {}
}
