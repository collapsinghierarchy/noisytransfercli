// src/commands/send.js
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { createSignalClient } from "../core/signal.js";
import { dialRTC } from "../core/rtc.js";

import { pqHandshakeSender } from "../modes/pq.js";
import { sendFileWithAuth } from "@noisytransfer/noisystream";

import tar from "tar-stream";
import micromatch from "micromatch";

const CHUNK = 64 * 1024;

/**
 * paths: string[] (files/dirs, or single "-" for stdin)
 * opts:  { relay, app, sessionId?, exclude?, pq? }
 */
export async function run(paths, opts) {
  if (!paths || !paths.length) throw new Error("send: missing input path");
  const useStdin = paths.length === 1 && paths[0] === "-";
  if (!useStdin && paths.includes("-")) throw new Error("send: '-' (stdin) cannot be combined with files/dirs");

  const side = "A";
  const sessionId = opts.sessionId || crypto.randomUUID();

  const signal = createSignalClient(opts.relay, opts.app, side);
  const rtc = await dialRTC("initiator", signal, { iceServers: [] });

  let sourceStream;       // Node Readable (for noisystream)
  let totalBytes;

  if (useStdin) {
    sourceStream = process.stdin;
    totalBytes = undefined;
  } else if (paths.length === 1 && await isRegularFile(paths[0])) {
    const abs = path.resolve(paths[0]);
    const st = await fsp.stat(abs);
    sourceStream = fs.createReadStream(abs, { highWaterMark: CHUNK });
    totalBytes = st.size;
  } else {
    const { pack, totalSizeEstimate } = await makeTarPack(paths, { exclude: opts.exclude });
    sourceStream = pack;
    totalBytes = totalSizeEstimate;
  }

  const usePQ = !!opts.pq;

  // progress
  const started = Date.now();
  let lastDraw = 0;
  const onProgress = (sent, total) => {
    const now = Date.now();
    if (now - lastDraw < 100) return;
    drawProgress(sent, total ?? totalBytes, started);
    lastDraw = now;
  };

  try {
    if (usePQ) {
      await pqHandshakeSender(rtc, { sessionId, onSAS: () => {}, confirm: true });
    }
    await sendFileWithAuth({ tx: rtc, sessionId, source: sourceStream, onProgress });
    process.stderr.write("\nDone • " + (typeof totalBytes === "number" ? humanBytes(totalBytes) : "—") + "\n");
  } finally {
    rtc.close?.();
    signal.close?.();
  }
}

/* -------------------------------- Helpers --------------------------------- */

async function isRegularFile(p) { try { const st = await fsp.stat(p); return st.isFile(); } catch { return false; } }

async function makeTarPack(inputPaths, { exclude } = {}) {
  const ex = (exclude || "").split(",").map((s) => s.trim()).filter(Boolean);
  const files = await collectFiles(inputPaths, ex);
  const totalSizeEstimate = files.reduce((acc, f) => acc + f.size, 0);

  const pack = tar.pack();
  (async () => {
    try {
      for (const f of files) {
        await new Promise((resolve, reject) => {
          const header = { name: f.rel, size: f.size, mode: f.mode, mtime: f.mtime };
          const entry = pack.entry(header, (err) => err ? reject(err) : resolve());
          fs.createReadStream(f.abs, { highWaterMark: CHUNK }).on("error", reject).pipe(entry);
        });
      }
    } catch (e) { pack.destroy(e); return; }
    pack.finalize();
  })();

  return { pack, totalSizeEstimate };
}

async function collectFiles(paths, excludes) {
  const files = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    const base = path.basename(abs);
    const st = await fsp.stat(abs);
    if (st.isFile()) {
      const rel = base;
      if (!isExcluded(rel, excludes)) files.push({ abs, rel, size: st.size, mode: st.mode, mtime: st.mtime });
    } else if (st.isDirectory()) {
      const root = abs;
      const entries = await walkDir(abs);
      for (const entry of entries) {
        const rel = path.posix.normalize(path.relative(root, entry).split(path.sep).join(path.posix.sep));
        if (isExcluded(rel, excludes)) continue;
        const est = await fsp.stat(entry);
        if (!est.isFile()) continue;
        files.push({ abs: entry, rel: path.posix.join(base, rel), size: est.size, mode: est.mode, mtime: est.mtime });
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

function isExcluded(relPosixPath, excludes) {
  if (!excludes || !excludes.length) return false;
  return micromatch.isMatch(relPosixPath, excludes, { dot: true, nocase: true });
}
async function walkDir(dir) {
  const out = []; const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    const items = await fsp.readdir(d, { withFileTypes: true });
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) stack.push(full); else out.push(full);
    }
  }
  return out;
}

/* ------------------------------- Progress UI ------------------------------- */

function drawProgress(done, total, startedAt) {
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = done / Math.max(0.001, elapsed);
  const humanRate = humanBytes(rate) + "/s";
  let line = "";
  if (typeof total === "number" && total > 0) {
    const pct = Math.min(1, done / total);
    const width = 28;
    const bar = Math.max(0, Math.min(width, Math.floor(pct * width)));
    const eta = rate > 0 ? (total - done) / rate : Infinity;
    line = `[${"#".repeat(bar)}${".".repeat(width - bar)}] ${(pct * 100).toFixed(1)}% • ${humanBytes(done)}/${humanBytes(total)} • ${humanRate} • ETA ${formatETA(eta)}`;
  } else {
    line = `${humanBytes(done)} sent • ${humanRate}`;
  }
  process.stderr.write("\r" + line);
}
function humanBytes(n) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
function formatETA(s) {
  if (!isFinite(s) || s <= 0) return "—";
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = Math.floor(s % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
