#!/usr/bin/env node
// Load env/polyfills (crypto, ws, socks, WebRTC) exactly once
import "./env/node-polyfills.js";

import { Command, InvalidOptionArgumentError } from "commander";
import { createCode, redeemCode, formatReceiverCommand } from "./api/rendezvous.js";
import { resolveCfg, assertRelay } from "./config/resolve.js";
import { ensureRTC } from "./env/rtc-init.js";

function nonEmpty(v) {
  if (!v || String(v).trim() === "") throw new InvalidOptionArgumentError("must not be empty");
  return v;
}

// Robust option merge that works across commander versions and pkg bundling.
function mergedOptsFrom(command, handlerOptions) {
  let globalish = {};
  try {
    if (typeof command?.optsWithGlobals === "function") {
      globalish = command.optsWithGlobals();
    } else {
      const parent = typeof command?.parent?.opts === "function" ? command.parent.opts() : {};
      const self = typeof command?.opts === "function" ? command.opts() : {};
      globalish = { ...parent, ...self };
    }
  } catch {}
  // Handler options can be a plain object; ignore if not.
  const handler = handlerOptions && typeof handlerOptions === "object" ? handlerOptions : {};
  return { ...globalish, ...handler };
}

function withDefaults(opts = {}) {
  const base = resolveCfg(opts);
  return {
    relay: base.relay,
    apiBase: base.apiBase,
    ttlSec: base.ttlSec,
    pq: !!opts.pq,
    yes: !!opts.yes,
    overwrite: !!opts.overwrite,
    exclude: opts.exclude ?? [],
  };
}

function printBanner({ pq }) {
  const mode = pq ? "PQ/HPKE (end-to-end app-layer crypto)" : "DTLS (default)";
  process.stderr.write(`noisytransfer CLI – mode: ${mode}\n`);
}

function initRTCOnce() {
  try {
    ensureRTC();
  } catch (e) {
    console.error(e?.message || e);
    process.exit(2);
  }
}

const program = new Command();
program
  .name("nt")
  .description("NoisyTransfer CLI – simple send/recv over WebRTC")
  .option("--relay <ws-url>", "websocket relay url (e.g. ws://127.0.0.1:1234/ws)", nonEmpty)
  .option("--api <http-url>", "api base (same origin as relay)", nonEmpty)
  .option("--pq", "enable PQ/HPKE app-layer encryption")
  .option("--yes", "assume yes for interactive prompts (SAS)")
  .hook("preAction", () => initRTCOnce());

// --- send ---
program
  .command("send")
  .argument("<path...>", "files or directories to send (use - for stdin)")
  .description("create a code and send files")
  .option("--exclude <globs...>", "exclude patterns (micromatch)")
  .action(async function (paths, options) {
    const allOpts = mergedOptsFrom(this, options);
    const { relay, apiBase, ttlSec, pq, exclude } = withDefaults(allOpts);
    assertRelay(relay);
    printBanner({ pq });

    const { status, code, appID } = await createCode({ relay, apiBase, ttlSec });
    if (status !== "ok" || !code || !appID)
      throw new Error(`createCode failed: ${status || "unknown"}`);

    const { short, explicit } = formatReceiverCommand({ code, relay, apiBase });
    process.stderr.write(`Code: ${code}\n`);
    process.stderr.write(`Receiver can run either:\n  ${short}\n  ${explicit}\n`);

    const { run: runSend } = await import("./commands/send.js");
    await runSend(paths, { relay, app: appID, pq, exclude, yes: !!allOpts.yes });
  });

// --- recv ---
program
  .command("recv")
  .argument("[outDir]", "output directory (defaults to cwd)")
  .requiredOption("--code <CODE>", "code to redeem", nonEmpty)
  .description("receive files for a given code")
  .option("--overwrite", "overwrite existing files")
  .action(async function (outDir, options) {
    const allOpts = mergedOptsFrom(this, options);
    const { relay, apiBase, pq, yes, overwrite } = withDefaults(allOpts);
    assertRelay(relay);
    printBanner({ pq });

    const code = options?.code;
    const resp = await redeemCode({ relay, apiBase, code });
    if (resp.status !== "ok" || !resp.appID)
      throw new Error(`redeem failed: ${resp.status || "unknown"}`);

    const { run: runRecv } = await import("./commands/recv.js");
    await runRecv(outDir, { relay, app: resp.appID, pq, yes, overwrite });
  });

// --- shorthand: nt CODE ---
program.argument("[codeOrNothing]").action(async function (maybeCode /*, options */) {
  if (!maybeCode) {
    program.help({ error: false });
    return;
  }
  const allOpts = mergedOptsFrom(this, {});
  const { relay, apiBase, pq, yes } = withDefaults(allOpts);
  assertRelay(relay);
  printBanner({ pq });

  const resp = await redeemCode({ relay, apiBase, code: maybeCode });
  if (resp.status !== "ok" || !resp.appID)
    throw new Error(`redeem failed: ${resp.status || "unknown"}`);

  const { run: runRecv } = await import("./commands/recv.js");
  await runRecv(undefined, { relay, app: resp.appID, pq, yes });
});

process.on("SIGINT", () => {
  process.stderr.write("\n");
  process.exit(130);
});

async function main() {
  try {
    await program.parseAsync();
  } catch (e) {
    console.error(e?.stack || e);
    process.exit(1);
  }
}
main();
