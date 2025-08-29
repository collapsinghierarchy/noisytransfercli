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

function randomPort() { return 12000 + Math.floor(Math.random()*2000); }

async function startBroker(port) {
  const script = path.resolve("scripts/ws-broker.js");
  const child = spawn(process.execPath, [script, String(port)], { stdio: ["ignore","inherit","inherit"] });
  await new Promise(r => setTimeout(r, 300));
  return {
    url: `ws://localhost:${port}/ws`,
    stop: () => { try { child.kill(); } catch {} }
  };
}

test("DTLS send/recv single file end-to-end", { timeout: 30_000 }, async () => {
  const port = randomPort();
  const broker = await startBroker(port);
  const relay = broker.url;
  const appID = crypto.randomUUID();

  const tmpDir = await fsp.mkdtemp(path.join(process.cwd(), "nt-test-"));
  const inPath = path.join(tmpDir, "in.bin");
  const outDir = path.join(tmpDir, "out");
  await fsp.mkdir(outDir, { recursive: true });

  const data = Buffer.alloc(1_200_000);
  for (let i=0;i<data.length;i++) data[i] = i % 251;
  await fsp.writeFile(inPath, data);

  const recvP = runRecv(outDir, { relay, app: appID, sign: false, overwrite: true, pq: false });
  const sendP = runSend([inPath], { relay, app: appID, sign: false, pq: false });

  await Promise.all([recvP, sendP]);

  const received = await fsp.readFile(path.join(outDir, "received.bin"));
  assert.equal(received.length, data.length);
  assert.equal(Buffer.compare(received, data), 0);

  broker.stop();
});
