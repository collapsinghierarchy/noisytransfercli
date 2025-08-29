#!/usr/bin/env node
import "./env/node-polyfills.js";

import { Command } from "commander";
import { createCode, redeemCode, formatReceiverCommand } from "./api/rendezvous.js";
import { run as runSend } from "./commands/send.js";
import { run as runRecv } from "./commands/recv.js";

const DEFAULT_RELAY = process.env.NT_RELAY || "wss://your-relay.example/ws";
const DEFAULT_API   = process.env.NT_API_BASE || undefined;
const DEFAULT_TTL_SEC = Number(process.env.NT_CODE_TTL_SEC || 600);

function printBanner({ pq } = {}) {
  const mode = pq ? "PQ (HPKE app-layer E2EE)" : "DTLS (non-PQ)";
  process.stderr.write(`NoisyTransfer nt • Mode: ${mode}\n`);
}

const program = new Command();
program
  .name("nt")
  .description("NoisyTransfer CLI — secure peer-to-peer transfer (DTLS default; --pq for HPKE app-layer E2EE)")
  .version("0.2.0");

program
  .option("--relay <url>", "WebSocket signaling relay URL", DEFAULT_RELAY)
  .option("--api <url>",   "HTTP API base URL (defaults to relay-derived or NT_API_BASE)", DEFAULT_API)
  .option("--pq",          "Enable PQ (HPKE) application-layer E2EE", false);

// Single-argument receiver shortcut: `nt [--pq] <code>`
program
  .argument("[code]", "Human-readable code (receiver shortcut)")
  .action(async (maybeCode, _opts, cmd) => {
    if (!maybeCode) return;
    const { relay, api, pq } = cmd.parent.opts();
    printBanner({ pq });
    const code = process.env.NT_SECRET || maybeCode;

    try {
      const resp = await redeemCode({ relay, apiBase: api, code });
      if (resp.status !== "ok" || !resp.appID) throw new Error(`redeem failed: ${resp.status || "unknown"}`);
      await runRecv("-", { relay, app: resp.appID, sessionId: undefined, sign: false, pq: !!pq });
    } catch (e) {
      console.error("receive error:", e?.message || e);
      process.exitCode = 1;
    }
  });

// `send` command
program
  .command("send")
  .description("Send file(s)/dir(s) or '-' for stdin; prints a human code")
  .argument("<pathOr->", "file/dir path or '-' for stdin")
  .argument("[morePaths...]", "additional files/dirs")
  .option("--code-ttl <sec>", "code expiry (seconds)", (v) => Number(v), DEFAULT_TTL_SEC)
  .option("--exclude <globs>", "comma-separated exclude globs (for dir/multi-file)")
  .option("--sign", "sign digest at FIN (extra integrity UX in DTLS path)", false)
  .action(async (firstPath, morePaths, opts, cmd) => {
    const { relay, api, pq } = cmd.parent.opts();
    printBanner({ pq });
    const paths = [firstPath, ...(morePaths || [])];

    try {
      const { code, appID, expiresAt } = await createCode({ relay, apiBase: api, ttlSec: opts.codeTtl });

      // Show receiver commands; include --pq if sender used it
      const { short, explicit } = formatReceiverCommand({ code, relay, apiBase: api });
      const shortPQ    = pq ? `${short} --pq` : short;
      const explicitPQ = pq ? `${explicit} --pq` : explicit;

      process.stderr.write(
        `\nCode: ${code}\n` +
        `Expires: ${expiresAt}\n\n` +
        `Receiver can run either:\n  ${shortPQ}\n  ${explicitPQ}\n\n`
      );

      await runSend(paths, {
        relay,
        app: appID,
        sessionId: undefined,
        sign: !!opts.sign,
        exclude: opts.exclude || undefined,
        pq: !!pq
      });
    } catch (e) {
      console.error("send error:", e?.message || e);
      process.exitCode = 1;
    }
  });

// `recv` command — explicit form
program
  .command("recv")
  .description("Receive to file/dir or '-' for stdout")
  .argument("[outPathOr-]", "output path or '-' for stdout (default: stdout for raw; directory for archives)")
  .option("--code <code>", "human-readable code (will be redeemed to appID)")
  .option("--app <uuid>", "direct room/appID (skips redeem)")
  .option("--out <dir>", "output directory (for tar archives); overrides positional path when set")
  .option("--yes", "answer 'yes' to all prompts (implies --overwrite where applicable)", false)
  .option("--overwrite", "allow overwriting existing files", false)
  .option("--sign", "expect signature+digest at FIN (DTLS path)", false)
  .action(async (outPath, opts, cmd) => {
    const { relay, api, pq } = cmd.parent.opts();
    printBanner({ pq });
    const codeFromEnv = process.env.NT_SECRET;

    try {
      let app = opts.app;
      if (!app) {
        const code = codeFromEnv || opts.code;
        if (!code) throw new Error("must provide --code or --app");
        const resp = await redeemCode({ relay, apiBase: api, code });
        if (resp.status !== "ok" || !resp.appID) throw new Error(`redeem failed: ${resp.status || "unknown"}`);
        app = resp.appID;
      }

      const effectiveOut = opts.out ? opts.out : (outPath || "-");

      await runRecv(effectiveOut, {
        relay,
        app,
        sessionId: undefined,
        sign: !!opts.sign,
        outDir: opts.out || undefined,
        yes: !!opts.yes,
        overwrite: !!opts.overwrite,
        pq: !!pq
      });
    } catch (e) {
      console.error("recv error:", e?.message || e);
      process.exitCode = 1;
    }
  });

if (process.argv.length <= 2) {
  program.addHelpText("after",
    "\nExamples:\n" +
    "  nt send ./bigfile.iso\n" +
    "  nt --pq <code>\n" +
    "  nt recv ./out --pq --code olive-sun-93  # extract archive into ./out\n"
  );
}

program.parseAsync().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
