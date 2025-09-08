import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import tar from "tar-stream";
import micromatch from "micromatch";

import { createSignalClient } from "../core/signal.js";
import { dialRTC } from "../core/rtc.js";
import { getIceConfig } from "../env/ice.js";
import { waitForRoomFull, withTimeout } from "../core/signal-helpers.js";
import { defaultSend } from "../transfer/default.js";
import { pqSend, wrapAuthDC } from "../transfer/pq.js";
import { parseStreamFin } from "@noisytransfer/noisystream/frames";
import { attachDcDebug } from "../core/dc-debug.js";
import { flush, forceCloseNoFlush, scrubTransport } from "@noisytransfer/transport";
import { hardExitIfEnabled } from "../env/hard-exit.js";

const CHUNK = 64 * 1024;

function deriveSendName(srcPath, opts) {
  if (opts?.name) return String(opts.name);
  if (!srcPath || srcPath === "-" || srcPath === "/dev/stdin") {
    return opts?.stdinName || "stdin.bin";
  }
  try { return path.basename(srcPath); }
  catch { return "nt-transfer.bin"; }
}

export async function run(paths, opts) {
  if (!paths || !paths.length) throw new Error("send: missing input path");
  const useStdin = paths.length === 1 && paths[0] === "-";
  if (!useStdin && paths.includes("-"))
    throw new Error("send: '-' (stdin) cannot be combined with files/dirs");
  if (useStdin && opts.size == null) throw new Error("stdin requires --size <bytes>");
  const firstPath = useStdin ? "-" : paths[0];
  // We compute the final send-name *after* we decide whether we’re tarring.
  let sendNameHint = null;
  // Prepare values we’ll need for hint + filenames
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const sessionId = opts.sessionId || opts.app;
  if (!sessionId) throw new Error("send: missing sessionId (expected from createCode/appID)");

  const signal = createSignalClient({ relayUrl: opts.relay, appID: opts.app, side: "A" });
  await signal.waitOpen?.(100000);
  
  if (process.env.NT_DEBUG) console.error("[NT_DEBUG] waiting for room_full…");
  await waitForRoomFull(signal, { timeoutMs: 90000 });
  if (process.env.NT_DEBUG) console.error("[NT_DEBUG] room_full seen — starting rtc initiator");

  const rtcCfg = getIceConfig();
  const rtc = await withTimeout(dialRTC("initiator", signal, rtcCfg), 30000, "dial initiator");

  // Build source + exact totalBytes
  let sourceStream;
  let totalBytes;

  if (useStdin) {
    sourceStream = process.stdin;
    totalBytes = Number(opts.size);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0)
      throw new Error("--size must be a positive integer for stdin");
    sendNameHint = deriveSendName(firstPath, opts);
  } else if (paths.length === 1 && (await isRegularFile(paths[0]))) {
    const abs = path.resolve(paths[0]);
    const st = await fsp.stat(abs);
    sourceStream = fs.createReadStream(abs, { highWaterMark: CHUNK });
    totalBytes = st.size;
    // Ensure receiver sees the intended filename; allow --name to override.
    // (Previously we only set a name for stdin or multi-path.)
    sendNameHint = deriveSendName(firstPath, opts);
  } else {
    // multi-path (or a directory) → stream a tar we build on the fly
    const { pack, totalSizeTar } = await makeTarPack(paths, { exclude: opts.exclude || [] });
    sourceStream = pack;
    totalBytes = totalSizeTar;
    sendNameHint = deriveSendName(firstPath, opts);
    // Set a stable .tar name unless user overrode with --name
    const base = path.basename(firstPath === "-" ? "stdin" : paths[0]);
    const stem = base.replace(/\.(tar|tgz|zip)$/i, "");
    sendNameHint = opts?.name ? String(opts.name) : `${stem}.tar`;
  }
   if (!Number.isInteger(totalBytes) || totalBytes <= 0) {
    throw new Error(`internal: computed totalBytes invalid (${totalBytes})`);
  }

  // Progress UI
  const t0 = Date.now();
  let lastTick = 0;
  function onProgress(sent, total) {
    const now = Date.now();
    if (now - lastTick < 120 && sent !== total) return;
    lastTick = now;
    const dt = (now - t0) / 1000;
    const speed = sent / Math.max(1, dt);
    const eta = speed > 0 ? (total - sent) / speed : Infinity;
    const pct = Math.max(0, Math.min(100, Math.floor((sent / total) * 100)));
    if (process.stderr.isTTY) {
      const msg = `\r${humanBytes(sent)}/${humanBytes(total)}  ${humanBytes(speed)}/s  ETA ${formatETA(eta)}  ${pct}%`;
      process.stderr.write(msg);
    } else {
      process.stderr.write(`${sent}\t${total}\n`);
    }
  }

  // Wait for FIN/OK from receiver or peer close
  const waitForFinAck = () =>
    new Promise((resolve) => {
      let settled = false;
      const offMsg = rtc.onMessage?.((m) => {
        if (settled) return;
        try {
          let msg = m;
          if (typeof m === "string") msg = JSON.parse(m);
          if (m instanceof Uint8Array || ArrayBuffer.isView(m)) {
            try {
              msg = JSON.parse(new TextDecoder().decode(m));
            } catch {}
          }
          const fin = msg ? parseStreamFin(msg) : null;
          if (fin && fin.sessionId === sessionId && fin.ok === true) {
            settled = true;
            offMsg?.();
            offClose?.();
            resolve();
          }
        } catch {}
      });
      const offClose = rtc.onClose?.(() => {
        if (settled) return;
        settled = true;
        offMsg?.();
        resolve();
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          offMsg?.();
          offClose?.();
          resolve();
        }
      }, 3000);
    });

  try {
    if (opts.pq) {
      const offDbg = attachDcDebug(rtc, { label: "pq-send", sessionId });
      const rtcAuth = wrapAuthDC(rtc, { sessionId, label: "pq-auth-sender" });
      await pqSend(rtcAuth, { sessionId, source: sourceStream, totalBytes, onProgress, name: sendNameHint });
      try {
        offDbg();
      } catch {}
    } else {
      await defaultSend(rtc, {
        sessionId,
        source: sourceStream,
        totalBytes,
        onProgress,
        name: sendNameHint,
        assumeYes: !!opts.yes
      });
    }

    try {
      onProgress(totalBytes, totalBytes);
    } catch {}

    if (typeof rtc?.flush === "function") {
      if (process.env.NT_DEBUG) console.error("[NT_DEBUG] flushing RTC bufferedAmount…");
      try {
        await rtc.flush();
      } catch {}
    } else {
      await sleep(150);
    }

    await waitForFinAck(rtc, sessionId, 7000);
    // Drain bufferedAmount so wrtc doesn’t die on teardown
    try { await flush(rtc, { timeoutMs: 15000 }); } catch {}
    // Let the peer close first to avoid races
    await waitForPeerClose(rtc, 1500);
    process.stderr.write("\nDone • " + humanBytes(totalBytes) + "\n");
    // --- Silent workaround on success
  } finally {
    // Hard, handler-safe close sequence
    try { await forceCloseNoFlush(rtc); } catch {}
    try { scrubTransport(rtc); } catch {}
    try { signal?.close?.(); } catch {}
    await hardExitIfEnabled({ code: 0 });
  }
}


/* ------------------------------- utilities ------------------------------- */

function waitForPeerClose(rtc, ms = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const off = rtc.onClose?.(() => { if (!done) { done = true; resolve(); } });
    setTimeout(() => { if (!done) { done = true; off?.(); resolve(); } }, ms);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function isRegularFile(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

// Builds a tar stream from one or more input paths.
// Returns { pack, totalSizeTar } where totalSizeTar is computed BEFORE returning.
// NOTE: this is async because we must pre-scan the filesystem.
async function makeTarPack(paths, { exclude = [] } = {}) {
  const pack = tar.pack();
  let totalSizeTar = 0;

  // 1) Pre-scan to collect files and sizes so we can compute the exact tar size.
  const entries = [];
  async function collect(p) {
   const abs = path.resolve(p);
    const st = await fsp.stat(abs);
    if (st.isFile()) {
      const base = path.basename(abs);
      if (exclude.length && micromatch.isMatch(base, exclude)) return;
      entries.push({ abs, size: st.size, name: base });
      return;
    }
    if (st.isDirectory()) {
      for (const name of await fsp.readdir(abs)) {
        await collect(path.join(abs, name));
      }
    }
    // ignore symlinks/others for now
  }
  for (const p of paths) {
    await collect(p);
  }

  // 2) Compute TAR size up front: per-file 512 header + size padded to 512, plus 1024 EOF.
  totalSizeTar = entries.reduce(
    (acc, { size }) => acc + 512 + Math.ceil(size / 512) * 512,
   0
  );
  totalSizeTar += 1024; // TAR EOF (two 512-byte blocks)

  // 3) Start streaming entries asynchronously; caller can begin sending immediately.
  (async () => {
   try {
      for (const { abs, size, name } of entries) {
       await new Promise((resolve, reject) => {
          const entry = pack.entry({ name, size }, (err) => (err ? reject(err) : resolve()));
          const rs = fs.createReadStream(abs, { highWaterMark: CHUNK });
          rs.on("error", reject);
          entry.on("error", reject);
         rs.pipe(entry);
        });
      }
      pack.finalize();
    } catch (e) {
      try { pack.destroy(e); } catch {}
    }
  })();

  return { pack, totalSizeTar };
}
