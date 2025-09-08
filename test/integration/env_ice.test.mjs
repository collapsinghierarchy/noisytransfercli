import { test } from "node:test";
import assert from "node:assert/strict";
import { getIceConfig } from "../../src/env/ice.js";

test("NT_ICE absent → {}", () => {
  delete process.env.NT_ICE;
  assert.deepEqual(getIceConfig(), {});
});

test("NT_ICE as array → { iceServers: [...] }", () => {
  process.env.NT_ICE = JSON.stringify([{ urls: "stun:stun.example.org" }]);
  assert.deepEqual(getIceConfig(), { iceServers: [{ urls: "stun:stun.example.org" }] });
});

test("NT_ICE as object → returns object", () => {
  process.env.NT_ICE = JSON.stringify({ iceTransportPolicy: "relay" });
  assert.deepEqual(getIceConfig(), { iceTransportPolicy: "relay" });
});

test("NT_ICE invalid JSON → {}", () => {
  process.env.NT_ICE = "not-json";
  assert.deepEqual(getIceConfig(), {});
});
