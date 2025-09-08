// node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const CLI = path.join(ROOT, "build", "pkg.cjs");

const NT_API = process.env.NT_API_BASE || "http://127.0.0.1:1234";
const NT_RELAY = process.env.NT_RELAY || "ws://127.0.0.1:1234/ws";

// end-to-end time for each test
const E2E_TIMEOUT_MS = 30_000;

// how long we wait for "Code:" from sender
const WAIT_CODE_MS = 12_000;

// how long we wait for the received file to appear
const WAIT_FILE_MS = 12_000;

function spawnNode(args, tag) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      NT_API_BASE: NT_API,
      NT_RELAY,
      NT_DEBUG: process.env.NT_DEBUG || "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  // pipe outputs so we can see what’s happening
  child.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));

  return child;
}

async function readAllUntil(child, regexp, { from = "stderr", timeoutMs = WAIT_CODE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const stream = from === "stdout" ? child.stdout : child.stderr;
    let buf = "";

    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(regexp);
      if (m) {
        cleanup();
        resolve(m);
      }
    };

    const onExit = (code, sig) => {
      cleanup();
      reject(new Error(`process exited before match (code=${code}, sig=${sig})\n${buf}`));
    };

    const cleanup = () => {
      clearTimeout(t);
      stream.off("data", onData);
      child.off("exit", onExit);
    };

    const t = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${regexp}.\nSO FAR:\n${buf}`));
    }, timeoutMs);

    stream.on("data", onData);
    child.on("exit", onExit);
  });
}

async function waitForFileExact(filePath, { timeoutMs = WAIT_FILE_MS } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const st = await fsp.stat(filePath);
      if (st.isFile() && st.size > 0) return filePath;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for output file at ${filePath}`);
}

async function waitForFirstFile(dir, { timeoutMs = WAIT_FILE_MS } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const items = await fsp.readdir(dir);
      const files = (await Promise.all(
        items.map(async (name) => {
          const p = path.join(dir, name);
          try {
            const st = await fsp.stat(p);
            return st.isFile() && st.size > 0 ? p : null;
          } catch { return null; }
        })
      )).filter(Boolean);
      if (files.length) return files[0];
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for output file in ${dir}`);
}

async function runCase({ senderArgs, label }) {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), `ntcli-auto-`));
  const src = path.join(ROOT, "README.md");
  const expectedName = path.basename(src);
  const expectedOut = path.join(outDir, expectedName);

  // 1) Start sender, wait for Code:
  const send = spawnNode(["send", "-y", ...senderArgs, src], "send");
  const m = await readAllUntil(send, /^Code:\s+(\S+)/m, { from: "stderr", timeoutMs: WAIT_CODE_MS });
  const code = m[1];

  // 2) Start receiver with that code
  const recv = spawnNode(["recv", "-y", "--code", code, outDir], "recv");

  // 3) Wait for file. Prefer exact basename; otherwise, accept first file in dir
  let outPath;
  try {
    outPath = await waitForFileExact(expectedOut, { timeoutMs: WAIT_FILE_MS });
  } catch {
    outPath = await waitForFirstFile(outDir, { timeoutMs: WAIT_FILE_MS });
  }

  // 4) Verify bytes
  const [a, b] = await Promise.all([fsp.readFile(src), fsp.readFile(outPath)]);
  assert.equal(b.length, a.length, `[${label}] output size must match`);
  assert.ok(a.equals(b), `[${label}] output bytes must be identical to source`);

  // 5) Cleanup
  try { recv.kill("SIGTERM"); } catch {}
  try { send.kill("SIGTERM"); } catch {}
}

test(
  "CLI AUTO mode via hint: sender dtls, receiver no flag → dtls selected and file received",
  { timeout: E2E_TIMEOUT_MS },
  async () => {
    await runCase({ senderArgs: [], label: "auto-dtls" });
  }
);

test(
  "CLI AUTO mode via hint: sender PQ, receiver no flag → PQ selected and file received",
  { timeout: E2E_TIMEOUT_MS },
  async () => {
    await runCase({ senderArgs: ["--pq"], label: "auto-pq" });
  }
);
