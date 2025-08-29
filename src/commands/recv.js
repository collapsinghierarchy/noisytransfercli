// src/commands/recv.js
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { createSignalClient } from "../core/signal.js";
import { dialRTC } from "../core/rtc.js";

import { pqHandshakeReceiver } from "../modes/pq.js";
import { recvFileWithAuth } from "@noisytransfer/noisystream";

import tar from "tar-stream";

const CHUNK = 64 * 1024;

/**
 * outPath: string | "-" | undefined
 * opts: { relay, app, sessionId?, outDir?, yes?, overwrite?, pq? }
 */
export async function run(outPath, opts) {
  const outToStdout = outPath === "-" || (!outPath && process.stdout.isTTY === false);
  const sessionId = opts.sessionId || crypto.randomUUID();

  const side = "B";
  const signal = createSignalClient(opts.relay, opts.app, side);
  const rtc = await dialRTC("responder", signal, { iceServers: [] });

  const usePQ = !!opts.pq;

  let totalBytes; let doneBytes = 0; let startedAt;
  const targetDir = opts.outDir || (outToStdout ? undefined : (outPath || process.cwd()));
  const overwrite = !!opts.overwrite || !!opts.yes;
  const sink = makeSniffingSink({ outToStdout, outDir: targetDir, outPath, overwrite });

  const onProgress = (n, total) => {
    totalBytes = total ?? totalBytes;
    doneBytes = n;
    const now = Date.now();
    if (!startedAt) startedAt = now;
    drawProgress(doneBytes, totalBytes, startedAt);
  };

  try {
    if (usePQ) {
      await pqHandshakeReceiver(rtc, { sessionId, onSAS: () => {}, confirm: true });
    }
    await recvFileWithAuth({ tx: rtc, sessionId, sink, onProgress });
    await sink.close();
    process.stderr.write(
      `\nDone • ${typeof totalBytes === "number" ? humanBytes(doneBytes) + "/" + humanBytes(totalBytes) : humanBytes(doneBytes)}\n`
    );
  } finally {
    rtc.close?.();
    signal.close?.();
  }
}

/* ------------------------------ Sink helpers ------------------------------ */

function makeSniffingSink({ outToStdout, outDir, outPath, overwrite }) {
  let sniffed = false; const sniffBuf = [];
  let writer = null; let finalizer = null; let extractor = null;

  async function initWriters(firstBytes) {
    const isTar = looksLikeTar(firstBytes);
    if (isTar) {
      if (outToStdout) throw new Error("received archive (tar). please provide an output directory (e.g., `nt recv ./out ...`).");
      const dir = path.resolve(outDir || process.cwd());
      await fsp.mkdir(dir, { recursive: true });
      ({ writer, finalizer, extractor } = await makeTarExtractor(dir, { overwrite }));
      await writer(firstBytes);
    } else {
      if (!outToStdout) {
        let filePath = outPath ? path.resolve(outPath) : undefined;
        if (!filePath || await isDirectory(filePath)) {
          const name = "received.bin";
          const dir = filePath && await isDirectory(filePath) ? filePath : (outDir || process.cwd());
          await fsp.mkdir(dir, { recursive: true });
          filePath = path.join(dir, name);
        }
        if (!overwrite && await pathExists(filePath)) throw new Error(`file exists: ${filePath} (use --overwrite or --yes)`);
        const stream = fs.createWriteStream(filePath, { flags: overwrite ? "w" : "wx", mode: 0o600, highWaterMark: CHUNK });
        writer = async (c) => { stream.write(Buffer.from(c)); };
        finalizer = async () => { await finished(stream); };
        await writer(firstBytes);
      } else {
        writer = async (c) => { process.stdout.write(Buffer.from(c)); };
        finalizer = async () => {};
        await writer(firstBytes);
      }
    }
  }

  return {
    write: async (u8) => {
      if (!sniffed) {
        sniffBuf.push(u8);
        const first = concatChunks(sniffBuf, Math.max(600, u8.byteLength));
        await initWriters(first);
        sniffBuf.length = 0;
        sniffed = true;
        return;
      }
      await writer(u8);
    },
    close: async () => {
      await finalizer?.();
      if (extractor) extractor.end();
    }
  };
}

/* ------------------------------- TAR helpers ------------------------------- */

function concatChunks(chunks, minLen) {
  const total = Math.max(minLen, chunks.reduce((a, c) => a + c.byteLength, 0));
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.min(c.byteLength, out.length - off));
    out.set(slice, off);
    off += slice.length;
    if (off >= out.length) break;
  }
  return out.subarray(0, off);
}
function looksLikeTar(buf) {
  if (!buf || buf.byteLength < 512) return false;
  const MAGIC_OFF = 257;
  const magic = Buffer.from(buf.subarray(MAGIC_OFF, MAGIC_OFF + 5)).toString("ascii");
  return magic === "ustar";
}
async function isDirectory(p) { try { const st = await fsp.stat(p); return st.isDirectory(); } catch { return false; } }
async function pathExists(p) { try { await fsp.access(p, fs.constants.FOO_OK ?? fs.constants.F_OK); return true; } catch { return false; } }
function finished(stream) { return new Promise((res, rej) => { stream.on("error", rej); stream.on("finish", res); stream.end(); }); }

async function makeTarExtractor(targetDir, { overwrite }) {
  const extract = tar.extract(); let errorOccurred;
  extract.on("entry", async (header, stream, next) => {
    try {
      const safeRel = sanitizeRelPath(header.name);
      if (!safeRel) { stream.resume(); return next(); }
      const full = secureJoin(targetDir, safeRel);
      if (!full.startsWith(targetDir + path.sep) && full !== targetDir) { stream.resume(); return next(); }
      if (header.type === "directory") {
        await fsp.mkdir(full, { recursive: true, mode: header.mode ?? 0o755 });
        stream.resume(); return next();
      }
      await fsp.mkdir(path.dirname(full), { recursive: true });
      if (!overwrite && await pathExists(full)) throw new Error(`file exists: ${full} (use --overwrite or --yes)`);
      const ws = fs.createWriteStream(full, { flags: overwrite ? "w" : "wx", mode: header.mode ?? 0o600, highWaterMark: CHUNK });
      stream.on("error", (e) => ws.destroy(e));
      ws.on("error", (e) => { errorOccurred = e; stream.destroy(e); });
      ws.on("finish", () => next());
      stream.pipe(ws);
    } catch (e) { errorOccurred = e; stream.resume(); next(e); }
  });
  const writer = async (chunk) => { if (!extract.write(Buffer.from(chunk))) await new Promise((r) => extract.once("drain", r)); };
  const finalizer = async () => { extract.end(); if (errorOccurred) throw errorOccurred; };
  return { writer, finalizer, extractor: extract };
}

function sanitizeRelPath(pth) {
  if (!pth) return "";
  let p = pth.replace(/\\/g, "/"); p = p.replace(/^\/+/, "");
  const parts = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join("/");
}
function secureJoin(root, rel) { const joined = path.join(root, rel); return path.resolve(joined); }

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
    line = `${humanBytes(done)} recv • ${humanRate}`;
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
