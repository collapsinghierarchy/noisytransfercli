import { test } from "node:test";
import assert from "node:assert/strict";
import { humanBytes, formatETA } from "../../src/util/format.js";

test("humanBytes", () => {
  assert.equal(humanBytes(0), "0.0 B");
  assert.equal(humanBytes(1024), "1.0 KiB");
  assert.equal(humanBytes(1024*1024), "1.0 MiB");
});

test("formatETA", () => {
  assert.equal(formatETA(0), "0:00");
  assert.equal(formatETA(61), "1:01");
  assert.equal(formatETA(Infinity), "—");
});
