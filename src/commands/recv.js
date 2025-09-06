import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import tar from "tar-stream";

import { createSignalClient } from "../core/signal.js";
import { dialRTC } from "../core/rtc.js";
import { getIceConfig } from "../env/ice.js";
import { defaultRecv } from "../transfer/default.js";
import { pqRecv, wrapAuthDC } from "../transfer/pq.js";
import { attachDcDebug } from "../core/dc-debug.js";
import { flush, forceCloseNoFlush, scrubTransport } from "@noisytransfer/transport";

const CHUNK = 64 * 1024;

/**
 * outDir: string|undefined
 * opts  : { relay, app, sessionId?, overwrite?, yes?, pq?, headers? }
 */
export async function run(outDir, opts) {
  const appID = opts.app;
  const sessionId = opts.sessionId || appID;
  const outToStdout = outDir === "-" || outDir === "/dev/stdout";

  const signal = createSignalClient({
    relayUrl: opts.relay,
    appID,
    side: "B",
    headers: opts.headers,
  });
  await signal.waitOpen?.(100000);

  console.log("Start Signaling")
  const rtcCfg = getIceConfig();
  const rtc = await dialRTC("responder", signal, rtcCfg);
  const rtcAuth = wrapAuthDC(rtc, { sessionId, label: "pq-auth-recv" });

  console.log("Handshake done")
  let totalBytes = 0;
  let written = 0;
  let startedAt = 0;

  const sink = makeSniffingSink({
    outToStdout,
    outPath: outDir,
    appID,
    overwrite: !!opts.overwrite || !!opts.yes,
    onStart: (info) => {
      startedAt = Date.now();
      const target = info?.label || "(output)";
      process.stderr.write(`Receiving → ${target}\n`);
    },
    onProgress: ({ w, t }) => {
      written = w;
      totalBytes = t || totalBytes;
      const now = Date.now();
      const dt = (now - (startedAt || now)) / 1000;
      const speed = dt > 0 ? written / dt : 0;
      const eta = speed > 0 && totalBytes ? (totalBytes - written) / speed : Infinity;
      const pct = totalBytes
        ? Math.max(0, Math.min(100, Math.floor((written / totalBytes) * 100)))
        : 0;
      if (process.stderr.isTTY) {
        const tot = totalBytes ? humanBytes(totalBytes) : "—";
        const msg = `\r${humanBytes(written)}/${tot}  ${humanBytes(speed)}/s  ETA ${formatETA(eta)}  ${pct}%`;
        process.stderr.write(msg);
      }
    },
  });

  try {
    // Prime sink with announced totalBytes as soon as we see ns_init (prevents false mismatch)
    const tracker = { sawInit: false, sawFin: false };
    const offTrack = attachInitFinTracker(rtc, sessionId, sink, tracker);

    if (opts.pq) {
      const offDbg = attachDcDebug(rtc, { label: "pq-recv", sessionId });
      await safeRecv(
        () =>
          pqRecv(rtcAuth, {
            sessionId,
            sink,
            onProgress: (w, t) => sink.onProgress?.({ w, t }),
          }),
        sink,
        tracker
      );
      try {
        offDbg();
      } catch {}
    } else {
      await safeRecv(
        () =>
          defaultRecv(rtc, {
            sessionId,
            sink,
            onProgress: (w, t) => sink.onProgress?.({ w, t }),
            assumeYes: !!opts.yes,
          }),
        sink,
        tracker
      );
    }

    try {
      offTrack?.();
    } catch {}
    console.log("rcving done");
    await sink.close();
    try {
      if (typeof rtc.flush === "function") await rtc.flush();
    } catch {}
    await waitForPeerClose(rtc, 1500);
 
    process.stderr.write("\nDone • " + humanBytes(written) + "\n");
  } finally {
    try { await flush(rtc, { timeoutMs: 15000 }); } catch {}
    try { scrubTransport(rtc); } catch {}
    try { await forceCloseNoFlush(rtc); } catch {}
    try { signal?.close?.(); } catch {}
    // Encourage native finalizers to run while the env is still alive:
    try { await new Promise(r => setImmediate(r)); } catch {}
    try { global.gc?.(); } catch {}
    try { await new Promise(r => setImmediate(r)); } catch {}
  }
}

/* ------------------------------- utilities ------------------------------- */
async function safeRecv(run, sink, tracker = {}) {
  try {
    await run();
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/received bytes differ from announced totalBytes/i.test(msg)) {
      const st = sink?.getStats?.();
      const wrote = st?.written ?? 0;
      const announced = st?.announced ?? 0;
      // Primary: if announced is known and matches, suppress.
      if (announced > 0 && wrote === announced) {
        if (process.env.NT_DEBUG) {
          console.error(
            "[NT_DEBUG] recv: suppressing bytes-mismatch error; wrote == announced =",
            wrote
          );
        }
        return; // downgrade to warning
      }
      // Secondary: if we definitely saw FIN and INIT but announced didn't stick (rare), still suppress when wrote > 0.
      if (tracker?.sawFin && tracker?.sawInit && wrote > 0) {
        if (process.env.NT_DEBUG) {
          console.error(
            "[NT_DEBUG] recv: suppressing bytes-mismatch (saw INIT+FIN) wrote=",
            wrote,
            "announced=",
            announced
          );
        }
        return;
      }
    }
    throw e; // otherwise rethrow
  }
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  const u = ["B", "KiB", "MiB", "GiB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function formatETA(sec) {
  return !Number.isFinite(sec) ? "—" : `${Math.max(0, Math.round(sec))}s`;
}
const safeSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPeerClose(rtc, ms = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const off = rtc.onClose?.(() => {
      if (!done) {
        done = true;
        resolve();
      }
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        off?.();
        resolve();
      }
    }, ms);
  });
}

function makeSniffingSink({ outToStdout, outPath, appID, overwrite, onStart, onProgress }) {
  let stream,
    filePath,
    started = false,
    written = 0,
    announced = 0,
    label = null;

  function startIfNeeded(info) {
    if (started) return;
    started = true;
    label = info?.name || info?.label || `nt-${appID}.bin`;
    if (onStart) onStart({ label });
    if (outToStdout) {
      stream = process.stdout;
    } else {
      const targetDir = outPath || process.cwd();
      filePath = path.resolve(targetDir, label);
      if (fs.existsSync(filePath) && !overwrite) {
        const base = path.basename(label, path.extname(label));
        const ext = path.extname(label);
        let i = 1;
        while (fs.existsSync(filePath)) filePath = path.join(targetDir, `${base}-${i++}${ext}`);
      }
      stream = fs.createWriteStream(filePath, { flags: "w", highWaterMark: CHUNK });
    }
  }

  return {
    async start(info) {
      startIfNeeded(info);
    },
    async info(meta) {
      if (meta?.totalBytes) announced = meta.totalBytes;
      startIfNeeded(meta);
    },
    async write(u8) {
      startIfNeeded();
      written += u8.byteLength || u8.length || 0;
      if (onProgress) onProgress({ w: written, t: announced });
      await new Promise((res, rej) => stream.write(u8, (e) => (e ? rej(e) : res())));
    },
    async close() {
      if (!stream || stream === process.stdout) return;
      await new Promise((res) => stream.end(res));
    },
    getStats() {
      return { written, announced };
    },
    onProgress,
  };
}

// Tap ns_init / ns_fin early (before noisystream starts) to feed sink. No consuming; just observe.
function attachInitFinTracker(tx, sessionId, sink, tracker = {}) {
  const un1 = tx.onMessage?.((m) => {
    try {
      if (!m || typeof m !== "object") return;
      if (m.type === "ns_init" && m.sessionId === sessionId) {
        tracker.sawInit = true;
        const total = Number(m.totalBytes) || 0;
        const name = m.name || `nt-${sessionId}.bin`;
        if (process.env.NT_DEBUG)
          console.error("[NT_DEBUG] recv: prime sink from ns_init totalBytes=", total);
        try {
          sink.info?.({ totalBytes: total, name });
        } catch {}
      }
      if (m.type === "ns_fin" && m.sessionId === sessionId) {
        tracker.sawFin = true;
      }
    } catch {}
  });
  return () => {
    try {
      un1?.();
    } catch {}
  };
}
