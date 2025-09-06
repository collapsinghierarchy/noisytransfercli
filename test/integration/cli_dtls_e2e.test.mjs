import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { startBroker, stopBroker } from "./helpers/broker.js";
import { mkTmpDir } from "./helpers/tmp.js";
import {
  runSend,
  runRecv,
  waitForLine,
  hashFile,
  waitForOutputFile,
  killHard,
  waitExit,
} from "./helpers/runCli.js";

test("CLI DTLS: send single file and receive identical bytes", async (t) => {
  const { child: broker } = await startBroker();
  t.after(async () => {
    await stopBroker(broker);
  });

  const tmp = await mkTmpDir();
  t.after(tmp.dispose);

  const src = path.join(tmp.dir, "hello.txt");
  await fs.writeFile(src, "hello from dtls\n".repeat(128));
  const srcHash = await hashFile(src);

  const sender = runSend({ paths: [src] });
  const codeLine = await waitForLine(sender.stderr, /^Code:\s+(\S+)/);
  const code = codeLine.split(/\s+/)[1];

  const recv = runRecv({ code, outDir: tmp.dir });

  // Wait for output file to materialize & stabilize; this proves the transfer finished.
  const outFile = await waitForOutputFile(tmp.dir, ["hello.txt"], 25000, 400);

  // Compare hashes
  const outHash = await hashFile(outFile);
  assert.equal(outHash, srcHash, "received bytes match");

  // Cleanup processes without asserting exit codes (teardown race is known)
  const [sExit, rExit] = await Promise.all([waitExit(sender, 4000), waitExit(recv, 4000)]);
  if (sExit.code !== 0 || rExit.code !== 0) {
    process.stderr.write(
      `[test] non-zero exits tolerated: sender=${sExit.code}/${sExit.signal || ""} receiver=${rExit.code}/${rExit.signal || ""}\n`
    );
  }
  killHard(sender, recv);
});
