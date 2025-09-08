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
import { hardExitIfEnabled } from "../env/hard-exit.js";

const CHUNK = 64 * 1024;

/**
 * outDir: string|undefined
 * opts  : { relay, app, sessionId?, overwrite?, yes?, pq?, headers? }
 */
export async function run(outDir, opts) {
  const appID = opts.app;
  const sessionId = opts.sessionId || appID;
  const outToStdout = outDir === "-" || outDir === "/dev/stdout";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const signal = createSignalClient({
    relayUrl: opts.relay,
    appID,
    side: "B",
    headers: opts.headers,
  });
  await signal.waitOpen?.(100000);

  const rtcCfg = getIceConfig();
  const rtc = await dialRTC("responder", signal, rtcCfg);

  let mode;
  if (opts.pq === true) mode = "pq";
  else {
    mode = "dtls";
  } 

  if (process.env.NT_DEBUG) console.error("[NT_DEBUG] recv: selected mode =", mode);

  let totalBytes = 0;
  let written = 0;
  let startedAt = 0;

  const sink = makeSniffingSink({
    outToStdout,
    outPath: outDir,
    appID,
    overwrite: !!opts.overwrite,
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

    if (mode === "pq") {
      const rtcAuth = wrapAuthDC(rtc, { sessionId, label: "pq-auth-recv" });
      await safeRecv(() => pqRecv(rtcAuth, { sessionId, sink, onProgress: (w,t)=>sink.onProgress?.({w,t}) }), sink, tracker);

      try {
        offDbg();
      } catch {}
    } else {
      await safeRecv(() => defaultRecv(rtc, { sessionId, sink, onProgress: (w,t)=>sink.onProgress?.({w,t}), assumeYes: !!opts.yes }), sink, tracker);
    }

    try {
      offTrack?.();
    } catch {}
    await sink.close();
    try {
      if (typeof rtc.flush === "function") await rtc.flush();
    } catch {}
    await waitForPeerClose(rtc, 1500);
 
    process.stderr.write("\nDone • " + humanBytes(written) + "\n");
     // --- Silent workaround: exit cleanly before wrtc finalizers run
    // Close signaling so the relay doesn't hang on our socket, then bail.
  } finally {
    try { await flush(rtc, { timeoutMs: 15000 }); } catch {}
    try { scrubTransport(rtc); } catch {}
    try { await forceCloseNoFlush(rtc); } catch {}
    // Encourage native finalizers to run while the env is still alive:
    try { await new Promise(r => setImmediate(r)); } catch {}
    try { global.gc?.(); } catch {}
    try { await new Promise(r => setImmediate(r)); } catch {}
    try { signal?.close?.(); } catch {}
    await hardExitIfEnabled({ code: 0 });
  }
}

function waitNtModeOnDC(rtc, sessionId, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const off = rtc.onMessage?.((raw) => {
      if (done) return;
      let m = null;
      try {
        if (typeof raw === "string") m = JSON.parse(raw);
        else if (raw?.type) m = raw;
        else m = JSON.parse(new TextDecoder().decode(raw));
      } catch {}
      if (!m || m.sessionId !== sessionId) return;
      if (m.type === "nt_mode") {
        done = true;
        try { rtc.send(JSON.stringify({ type: "nt_mode_ack", sessionId })); } catch {}
        if (process.env.NT_DEBUG) console.error("[NT_DEBUG] dc: got nt_mode", m);
        off?.();
        resolve(m.mode === "pq" ? "pq" : "dtls");
      }
    });
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      off?.();
      reject(new Error("no nt_mode on DC within timeout"));
    }, timeoutMs);
  });
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

// Tap ns_init / ns_fin early (before noisystream starts) to feed sink with metadata only.
// Does NOT open the file (your sink.info() no longer starts the stream).
function attachInitFinTracker(tx, sessionId, sink, tracker = {}) {
  const off = tx.onMessage?.((m) => {
    try {
      if (!m || typeof m !== "object") return;

      // Announce totalBytes (and optional name if present) from ns_init
      if (m.type === "ns_init" && m.sessionId === sessionId) {
        tracker.sawInit = true;
        const total = Number(m.totalBytes) || 0;
        const meta = { totalBytes: total };
        if (m.name) meta.name = String(m.name); // harmless if absent
        if (process.env.NT_DEBUG) {
          console.error("[NT_DEBUG] recv: prime sink from ns_init totalBytes=", total, "name=", m.name ?? "(none)");
        }
        try { sink.info?.(meta); } catch {}
        return;
      }

      // Note when FIN arrives (used by safeRecv to suppress noisy mismatch warnings)
      if (m.type === "ns_fin" && m.sessionId === sessionId) {
        tracker.sawFin = true;
        return;
      }
    } catch {}
  });

  return () => { try { off?.(); } catch {} };
}

function makeSniffingSink({ outToStdout, outPath, appID, overwrite, onStart, onProgress }) {
  let stream,
    filePath,
    started = false,
    written = 0,
    announced = 0,
    label = null,
    desiredName = null; // <- set by sink.info({ name })

  function resolveTargetPath(baseName) {
    const targetDir = outPath || process.cwd();
    let p = path.resolve(targetDir, baseName);
    if (!overwrite && fs.existsSync(p)) {
      const stem = path.basename(baseName, path.extname(baseName));
      const ext  = path.extname(baseName);
      let i = 1;
      while (fs.existsSync(p)) p = path.join(targetDir, `${stem}-${i++}${ext}`);
    }
    return p;
  }

  function startIfNeeded(info) {
    if (started) return;
    started = true;

    // Prefer previously-announced desiredName (from nt_meta / header),
    // then any explicit info.name, else fallback.
    label = desiredName || info?.name || info?.label || `nt-${appID}.bin`;

    if (onStart) onStart({ label });

    if (outToStdout) {
      stream = process.stdout;
      return;
    }

    filePath = resolveTargetPath(label);
    stream = fs.createWriteStream(filePath, { flags: overwrite ? "w" : "wx", highWaterMark: CHUNK });
  }

  return {
    async start(info) {
      // rarely used, but keep behavior: starting here respects desiredName
      startIfNeeded(info);
    },

    async info(meta) {
      // IMPORTANT: do not start the stream here.
      // We only record metadata; the actual file is opened on first write,
      // when we (likely) already know the final filename from the data header.
      if (meta?.totalBytes != null) {
        const n = Number(meta.totalBytes);
        if (Number.isFinite(n) && n >= 0) announced = n;
      }
      if (meta?.name) {
        desiredName = String(meta.name);
      }
    },

    async write(u8) {
      // Decide the filename as late as possible (first write), so desiredName
      // from the meta header can be applied before creating the file.
      startIfNeeded();
      const buf = u8 instanceof Uint8Array ? u8 : Buffer.from(u8);
      if (!buf.byteLength) return;
      written += buf.byteLength;
      if (onProgress) onProgress({ w: written, t: announced });
      await new Promise((res, rej) => stream.write(buf, (e) => (e ? rej(e) : res())));
    },

    async close() {
      if (!stream || stream === process.stdout) return;
      await new Promise((res) => stream.end(res));
    },

    getStats() {
      return { written, announced, label };
    },

    onProgress,
  };
}
