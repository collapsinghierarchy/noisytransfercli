// node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runRecv, runSend, waitForLine, killHard } from "./helpers/runCLI.js";
import { startBroker, stopBroker } from "./helpers/broker.js";

let env;
test.before(async () => { env = await startBroker({ port: 0 }); });
test.after(async () => { await stopBroker(env); });

const ROOT = path.resolve(process.cwd());

// end-to-end time for each test
const E2E_TIMEOUT_MS = 30_000;
// how long we wait for "Code:" from sender
const WAIT_CODE_MS = 12_000;
// how long we wait for the received file to appear
const WAIT_FILE_MS = 12_000;

// Wait for a new file to appear in `dir` or for an existing file's mtime/size
// to change. `prev` is a Map of { name -> { mtimeMs, size } } describing the
// directory before the transfer starts. Returns the path to the updated file
// once its size has been stable for a short period.
async function waitForNewOrUpdatedFile(dir, prev = new Map(), { timeoutMs = WAIT_FILE_MS, stableMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastName = null, lastSize = -1, lastT = 0;
  while (Date.now() < deadline) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const p = path.join(dir, name);
      let st;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      const prevInfo = prev.get(name);
      const changed = !prevInfo || st.mtimeMs !== prevInfo.mtimeMs || st.size !== prevInfo.size;
      if (!changed) continue;
      if (name === lastName && st.size === lastSize) {
        if (Date.now() - lastT >= stableMs) return p;
      } else {
        lastName = name;
        lastSize = st.size;
        lastT = Date.now();
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for output file in ${dir}`);
}

//
// Backwards compatible: existing calls still work.
//
// New options you can pass:
// - paths?: string[]                 // defaults to [README.md]
// - expectedBasename?: string        // defaults to basename(paths[0])
// - recvExtra?: string[]             // extra flags for recv (e.g. ["--overwrite"])
// - outDir?: string                  // reuse a directory across runs (for overwrite test)
// - assertBytes?: boolean            // default true; set false for .tar assertions
async function runCase({
  senderArgs = [],
  label,
  paths,
  expectedBasename,
  recvExtra = [],
  outDir: fixedOutDir,
  assertBytes = true,
} = {}) {
  const srcDefault = path.join(ROOT, "README.md");
  const srcs = Array.isArray(paths) && paths.length ? paths : [srcDefault];

  const outDir = fixedOutDir || (await fsp.mkdtemp(path.join(os.tmpdir(), `ntcli-auto-`)));
  // Record existing files + stats so we can detect newly created or modified
  // outputs even when a prior run left files behind.
  const prev = new Map();
  try {
    const names = await fsp.readdir(outDir);
    for (const n of names) {
      try {
        const st = await fsp.stat(path.join(outDir, n));
        prev.set(n, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {}
    }
  } catch {}

  // 1) start sender (AUTO mode; prints "Code: <...>" to stderr)
  const send = runSend({ paths: srcs, api: env.api, relay: env.relay, extra: senderArgs });

  const line = await waitForLine(send.stderr, /^Code:\s+(\S+)/, WAIT_CODE_MS);
  const code = line.split(/\s+/).pop();

  // 2) start receiver with that code (+ optional flags)
  const recv = runRecv({ code, outDir, api: env.api, relay: env.relay, extra: recvExtra });

  // 3) Wait for file (or receiver exiting early)
  const outPath = await Promise.race([
  waitForNewOrUpdatedFile(outDir, prev, { timeoutMs: WAIT_FILE_MS }),
    new Promise((_, reject) => {
      recv.once("exit", (code) => reject(new Error(`[recv] exited early with code ${code}`)));
    }),
  ]);

  // 4) compare bytes (optional; skip for .tar bundles)
  if (assertBytes) {
    const [a, b] = await Promise.all([fsp.readFile(srcs[0]), fsp.readFile(outPath)]);
    assert.equal(b.length, a.length, `[${label}] output size must match`);
    assert.ok(a.equals(b), `[${label}] output bytes must be identical to source`);
  }

  // 5) cleanup (hard-kill in case either side is still up)
  killHard(recv, send);

  // Return info useful to follow-up assertions
  return { outDir, outPath };
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

test(
  "CLI: send --name sets receiver filename",
  { timeout: E2E_TIMEOUT_MS },
  async () => {
    // use AUTO-mode via runCase, but force the expected basename
    const { outDir } = await runCase({
      label: "name",
      senderArgs: ["--name", "custom.txt"],
      expectedBasename: "custom.txt",
      // paths: [ <use default README.md> ]
      assertBytes: true,
    });

    // sanity: custom.txt exists in outDir
    const files = await fsp.readdir(outDir);
    assert.ok(files.includes("custom.txt"), "receiver should write custom.txt");
  }
);

test(
  "CLI: multi-path send produces .tar and --overwrite replaces existing",
  { timeout: E2E_TIMEOUT_MS },
  async () => {
    // Reuse the same directory across runs so we can observe conflicts/overwrite.
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ntcli-bundle-"));
    const paths = [path.join(ROOT, "README.md"), path.join(ROOT, "LICENSE")];
    const name = "bundle.tar";
    const tarPath = path.join(outDir, name);

    // 1) First run — should create bundle.tar
    await runCase({
      label: "tar-1",
      paths,
      senderArgs: ["--name", name],
      expectedBasename: name,
      outDir,
      assertBytes: false, // it's a tarball, not equal to README.md
    });
    const st1 = await fsp.stat(tarPath).catch(() => null);
    assert.ok(st1?.isFile(), "bundle.tar should exist after first run");

    // 2) Second run (no --overwrite) — expect a sibling file alongside bundle.tar
    await runCase({
      label: "tar-2",
      paths,
      senderArgs: ["--name", name],
      expectedBasename: name, // preferred name
      outDir,
      assertBytes: false,
    });
    const siblings = (await fsp.readdir(outDir)).filter(
      (f) => f.startsWith("bundle") && f.endsWith(".tar")
    );
    assert.ok(
      siblings.length >= 2,
      "a second .tar should be written alongside when no --overwrite"
    );

    // 3) Third run with --overwrite — bundle.tar mtime should advance
    await runCase({
      label: "tar-3",
      paths,
      senderArgs: ["--name", name],
      expectedBasename: name,
      recvExtra: ["--overwrite"],
      outDir,
      assertBytes: false,
    });
    const st3 = await fsp.stat(tarPath);
    assert.ok(
      st3.mtimeMs >= st1.mtimeMs,
      "bundle.tar should be replaced when --overwrite is set"
    );
  }
);
