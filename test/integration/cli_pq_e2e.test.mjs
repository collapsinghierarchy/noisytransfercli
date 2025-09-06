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

test("CLI PQ: send single file and receive identical bytes (--pq)", async (t) => {
  const { child: broker } = await startBroker();
  t.after(async () => {
    await stopBroker(broker);
  });

  const tmp = await mkTmpDir();
  t.after(tmp.dispose);

  const src = path.join(tmp.dir, "hello-pq.txt");
  await fs.writeFile(src, "hello from pq\n".repeat(256));
  const srcHash = await hashFile(src);

  const sender = runSend({ paths: [src], extra: ["--pq"] });
  const codeLine = await waitForLine(sender.stderr, /^Code:\s+(\S+)/, 12000);
  const code = codeLine.split(/\s+/)[1];

  const recv = runRecv({ code, outDir: tmp.dir, extra: ["--pq"] });

  const outFile = await waitForOutputFile(tmp.dir, ["hello-pq.txt"], 30000, 500);
  const outHash = await hashFile(outFile);
  assert.equal(outHash, srcHash, "received bytes match");

  const [sExit, rExit] = await Promise.all([waitExit(sender, 5000), waitExit(recv, 5000)]);
  if (sExit.code !== 0 || rExit.code !== 0) {
    process.stderr.write(
      `[test] non-zero exits tolerated: sender=${sExit.code}/${sExit.signal || ""} receiver=${rExit.code}/${rExit.signal || ""}\n`
    );
  }
  killHard(sender, recv);
});
