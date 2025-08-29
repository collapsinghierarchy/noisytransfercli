import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;

import wrtc from "@roamhq/wrtc";
globalThis.RTCPeerConnection     ??= wrtc.RTCPeerConnection;
globalThis.RTCIceCandidate       ??= wrtc.RTCIceCandidate;
globalThis.RTCSessionDescription ??= wrtc.RTCSessionDescription;

import WebSocket from "ws";
globalThis.WebSocket = globalThis.WebSocket || WebSocket;

import { run as runSend } from "../../src/commands/send.js";
import { run as runRecv } from "../../src/commands/recv.js";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function randomPort() { return 14000 + Math.floor(Math.random()*2000); }

async function startBroker(port) {
  const script = path.resolve("scripts/ws-broker.js");
  const child = spawn(process.execPath, [script, String(port)], { stdio: ["ignore","inherit","inherit"] });
  await new Promise(r => setTimeout(r, 300));
  return {
    url: `ws://localhost:${port}/ws`,
    stop: () => { try { child.kill(); } catch {} }
  };
}

async function makeTree(root) {
  await fsp.mkdir(path.join(root, "dir/sub"), { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(root, "a.txt"), "hello world\n"),
    fsp.writeFile(path.join(root, "dir", "b.bin"), Buffer.from(Array.from({length: 200_000}, (_,i)=>i%251))),
    fsp.writeFile(path.join(root, "dir", "sub", "c.log"), "log\n".repeat(1000)),
  ]);
}

test("PQ send/recv directory (tar) end-to-end", { timeout: 40_000 }, async () => {
  const port = randomPort();
  const broker = await startBroker(port);
  const relay = broker.url;
  const appID = crypto.randomUUID();

  const tmpDir = await fsp.mkdtemp(path.join(process.cwd(), "nt-test-pq-"));
  const srcDir = path.join(tmpDir, "src");
  const outDir = path.join(tmpDir, "out");
  await makeTree(srcDir);

  const recvP = runRecv(outDir, { relay, app: appID, overwrite: true, pq: true });
  const sendP = runSend([srcDir], { relay, app: appID, pq: true });

  await Promise.all([recvP, sendP]);

  // verify key files
  const files = [
    "a.txt",
    path.join("dir", "b.bin"),
    path.join("dir", "sub", "c.log"),
  ];
  for (const rel of files) {
    const dst = path.join(outDir, path.basename(srcDir), rel);
    const src = path.join(srcDir, rel);
    const [a,b] = await Promise.all([fsp.readFile(src), fsp.readFile(dst)]);
    assert.equal(Buffer.compare(a,b), 0, `mismatch at ${rel}`);
  }

  broker.stop();
});
