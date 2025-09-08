import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { startBroker, stopBroker } from './helpers/broker.js';


let env;
test.before(async () => { env = await startBroker(); });
test.after(async () => { await stopBroker(env); });


const ROOT = path.resolve(process.cwd());
const CLI = path.join(ROOT, "build", "pkg.cjs");
const NT_API = env.api;
const NT_RELAY = env.relay;

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ntcli-"));
  return { dir, dispose: () => fs.rm(dir, { recursive: true, force: true }).catch(()=>{}) };
}

test("DTLS roundtrip single file with -y", async (t) => {
  const br = await startBroker({ env: { BROKER_PORT: "0" } });
  t.after(() => stopBroker(br));

  const { dir: outDir, dispose } = await makeTmp(); t.after(dispose);

  const recv = spawn(process.execPath, [CLI, "recv", "--code", "x", outDir], {
    env: { ...process.env, NT_API_BASE: NT_API, NT_RELAY: NT_RELAY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // create code for real and capture it from send side:
  const res = await fetch(`${NT_API}/rendezvous/code`, { method: "POST" });
  const { code } = await res.json();

  const send = spawn(process.execPath, [CLI, "send", "-y", "--app", code, path.join(ROOT, "README.md")], {
    env: { ...process.env, NT_API_BASE: NT_API, NT_RELAY: NT_RELAY },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [code1, code2] = await Promise.all([
    new Promise((r) => recv.once("exit", r)),
    new Promise((r) => send.once("exit", r)),
  ]);
  assert.equal(code1, 0);
  assert.equal(code2, 0);

  const files = await fs.readdir(outDir);
  assert.equal(files.length, 1);
});

test("PQ roundtrip using code suffix '-pq'", async (t) => {
  const br = await startBroker({ env: { BROKER_PORT: "0" } });
  t.after(() => stopBroker(br));

  const res = await fetch(`${NT_API}/rendezvous/code`, { method: "POST" });
  const { code } = await res.json();
  const pqCode = `${code}-pq`;

  const { dir: outDir, dispose } = await makeTmp(); t.after(dispose);

  const recv = spawn(process.execPath, [CLI, "recv", "--code", pqCode, outDir], {
    env: { ...process.env, NT_API_BASE: NT_API, NT_RELAY: NT_RELAY },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const send = spawn(process.execPath, [CLI, "send", "--app", code, "--pq", "-y", path.join(ROOT, "LICENSE")], {
    env: { ...process.env, NT_API_BASE: NT_API, NT_RELAY: NT_RELAY },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [r1, r2] = await Promise.all([
    new Promise((r) => recv.once("exit", r)),
    new Promise((r) => send.once("exit", r)),
  ]);
  assert.equal(r1, 0); assert.equal(r2, 0);
});

test("stdin → stdout pipe with explicit --size and --stdin-name", async (t) => {
  const br = await startBroker({ env: { BROKER_PORT: "0" } });
  t.after(() => stopBroker(br));

  const res = await fetch(`${NT_API}/rendezvous/code`, { method: "POST" });
  const { code } = await res.json();

  const recv = spawn(process.execPath, [CLI, "recv", "--code", code, "-"], {
    env: { ...process.env, NT_API_BASE: NT_API, NT_RELAY: NT_RELAY },
    stdio: ["ignore", "pipe", "pipe"], // capture stdout
  });

  const payload = Buffer.from("hello world");
  const send = spawn(process.execPath, [CLI, "send", "--app", code, "--size", String(payload.length), "--stdin-name", "x.bin", "-y", "-"], {
    env: { ...process.env, NT_API_BASE: NT_API, NT_RELAY: NT_RELAY },
    stdio: ["pipe", "pipe", "pipe"],
  });
  send.stdin.end(payload);

  const out = await new Promise((resolve) => {
    const chunks = [];
    recv.stdout.on("data", (d) => chunks.push(d));
    recv.on("exit", () => resolve(Buffer.concat(chunks)));
  });
  assert.equal(out.toString(), "hello world");
});
