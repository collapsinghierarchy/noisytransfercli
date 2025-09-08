import { test } from "node:test";
import assert from "node:assert/strict";
import { startBroker, stopBroker } from "./helpers/broker.js";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const ROOT = path.resolve(process.cwd());
const CLI = path.join(ROOT, "build", "pkg.cjs");
const NT_API = process.env.NT_API_BASE || "http://127.0.0.1:1234";
const NT_RELAY = process.env.NT_RELAY || "ws://127.0.0.1:1234/ws";

test("nt <code> is rewritten to recv --code <code>", async (t) => {
  const br = await startBroker({ env: { BROKER_PORT: "0" } });
  t.after(() => stopBroker(br));

  // Ask broker for a code (HTTP)
  const res = await fetch(`${NT_API}/rendezvous/code`, { method: "POST" });
  const { code } = await res.json();
  assert.ok(code);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ntcli-out-"));
  const out = path.join(tmp, "x.bin");

  const recv = spawn(process.execPath, [CLI, code, tmp], {
    env: { ...process.env, NT_API_BASE: NT_API, NT_RELAY: NT_RELAY, NT_DEBUG: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // sender
  const data = crypto.randomUUID();
  const send = spawn(process.execPath, [CLI, "send", "--app", code, "-y", path.join(ROOT, "package.json")], {
    env: { ...process.env, NT_API_BASE: NT_API, NT_RELAY: NT_RELAY },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((r) => recv.once("exit", r));
  const files = await fs.readdir(tmp);
  assert.ok(files.length === 1, "one file produced");
});
