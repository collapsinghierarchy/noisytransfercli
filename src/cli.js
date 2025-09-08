// Load env/polyfills (crypto, ws, socks, WebRTC) exactly once
import "./env/node-polyfills.js";

import { Command, InvalidOptionArgumentError } from "commander";
import { createCode, redeemCode } from "./api/rendezvous.js";
import { resolveCfg } from "./config/resolve.js";
import { ensureRTC } from "./env/rtc-init.js";
import { createLogger, setGlobalLogger } from "./util/logger.js";
import { EXIT } from "./env/exit-codes.js";
import { mapErrorToExitCode } from "./util/exit.js";
import { validateSendOptions, validateRecvOptions } from "./util/validate.js";
import pkg from "../package.json" assert { type: "json" };

// subcommand handlers
import * as Send from "./commands/send.js";
import * as Recv from "./commands/recv.js";

/* ----------------------------- process guards ---------------------------- */

process.on("SIGINT", () => {
  try { process.stderr.write("\n"); } catch {}
  process.exit(EXIT.CANCELED);
});

process.on("unhandledRejection", (err) => {
  const e = err instanceof Error ? err : new Error(String(err));
  try { console.error(e.stack || e.message || String(e)); } catch {}
  process.exit(mapErrorToExitCode(e));
});

/* --------------------------------- utils -------------------------------- */

function nonEmpty(v) {
  if (!v || String(v).trim() === "") throw new InvalidOptionArgumentError("must not be empty");
  return v;
}
function parseIntStrict(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new InvalidOptionArgumentError("must be a non-negative integer");
  return n;
}

// Accept 4–12 alnum, optional "-pq" suffix
function isPairingCode(s) {
  return typeof s === "string" && /^[0-9a-z]{4,12}(?:-pq)?$/i.test(s?.trim?.() ?? "");
}
// Returns { pq:boolean, code:string (no suffix) }
function parseModeFromCode(input) {
  const s = String(input || "").trim();
  const m = s.match(/^([0-9a-z]{4,12})(?:-pq)?$/i);
  return { pq: /-pq$/i.test(s), code: m ? m[1] : s };
}

/* ----------------------------- root shorthand ---------------------------- */
/**
 * Shorthand:
 *   nt <code>             -> nt recv --code <code>
 *   nt <code> <outDir>    -> nt recv <outDir> --code <code>
 * Only rewrite when it's unambiguous.
 */
{
  const argv = process.argv.slice(2);
  const KNOWN = new Set(["send", "recv", "rcv", "receive", "help", "version", "-h", "--help", "-V", "--version"]);
  if (argv.length >= 1 && !argv[0]?.startsWith("-") && !KNOWN.has(argv[0]) && isPairingCode(argv[0])) {
    const code = argv[0];
    if (argv.length === 1) {
      process.argv.splice(2, process.argv.length, "recv", "--code", code);
    } else if (argv.length === 2 && !argv[1].startsWith("-")) {
      process.argv.splice(2, process.argv.length, "recv", argv[1], "--code", code);
    }
  }
}

/* ------------------------------ commander init --------------------------- */

const program = new Command();
program
  .name("nt")
  .description("noisytransfer CLI")
  .version(pkg.version || "0.0.0");

if (typeof program.showHelpAfterError === "function") program.showHelpAfterError();
if (typeof program.showSuggestionAfterError === "function") program.showSuggestionAfterError();

program.addHelpText("before", `
Fast E2EE WebRTC file transfer (DTLS by default, optional PQ) with human-readable pairing codes.

Quick examples:
  $ nt send ./file.txt
  $ nt send --pq ./iso.img
  $ nt 1402
  $ nt recv ./downloads 5527e74d-pq
  $ nt recv - --code 1402 > out.bin
`.trim());

program.addHelpText("after", `
Notes:
  • Sender decides the mode: DTLS (default) or PQ via --pq. If PQ is used, the printed code ends with "-pq".
  • The receiver never takes a PQ flag; it infers PQ strictly from a "-pq" suffix on the code.
  • Receiver chooses the output directory; announced filenames are sanitized.
  • Multi-path sends are tarred on the wire; receiver writes "bundle.tar" (deduped unless --overwrite).
`.trim());

/* ---------------------------------- RECV --------------------------------- */

program
  .command("recv")
  .alias("rcv")
  .alias("receive")
  .description("Receive files. If the code ends with \"-pq\", PQ mode is used; otherwise DTLS.")
  .argument("[outDir]", "Output directory (or '-' for stdout). Defaults to current directory.", ".")
  .argument("[code]", "Pairing code (shorthand for --code).")
  .option("--code <code>", "Rendezvous code to redeem.")
  .option("--app <uuid>", "Rendezvous appID (skip redeem).")
  .option("--relay <wsUrl>", "Signaling relay (ws[s]://...).")
  .option("--api <httpUrl>", "Rendezvous HTTP API base (http[s]://...).")
  .option("--headers <json>", "JSON object with custom HTTP headers.", JSON.parse)
  .option("-y, --yes", "Auto-accept SAS prompt (no TTY). Does NOT overwrite files.", false)
  .option("--overwrite", "Overwrite existing files at destination.", false)
  .option("-v, --verbose", "Increase verbosity (repeatable).", (v, total) => total + 1, 0)
  .option("-q, --quiet", "Suppress non-error logs.", false)
  .option("--json", "Emit JSON logs on stderr.", false)
  .action(async (outDirArg, codeMaybe, opts) => {
    const { api, relay, headers } = resolveCfg({ relay: opts.relay, api: opts.api, headers: opts.headers });
    const cfg = { api, relay, headers };
    const logger = createLogger({
      level: opts.quiet ? "error" : (opts.verbose >= 1 ? "debug" : "info"),
      json: !!opts.json,
    });
    setGlobalLogger(logger);

    try {
      // Heuristic: if first arg looks like a code and no explicit code provided, treat it as code
      let outDir = outDirArg || ".";
      let code = opts.code || codeMaybe || null;
      if (!opts.code && !code && isPairingCode(outDirArg)) {
        code = outDirArg;
        outDir = ".";
      }

      // Redeem code → appID (unless --app is already provided)
      let appID = opts.app || null;
      let pq = false;
      if (!appID && code) {
        const parsed = parseModeFromCode(code);
        pq = parsed.pq; 
        const res = await redeemCode({ apiBase: cfg.api, code: parsed.code, headers: cfg.headers });
        if (!res?.appID) throw new Error("recv: failed to redeem code");
        appID = res.appID;
      }
      if (!appID) throw new Error("recv: either --code or --app is required");

      await validateRecvOptions(outDir, opts);

      await Recv.run(
        outDir,
        {
          app: appID,
          relay: cfg.relay,
          headers: cfg.headers,
          pq, 
          overwrite: !!opts.overwrite,
          yes: !!opts.yes,
        },
        { logger }
      );

      process.exit(EXIT.OK);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error(e.stack || e.message || String(e));
      process.exit(mapErrorToExitCode(e));
    }
  });

/* ---------------------------------- SEND --------------------------------- */

program
  .command("send")
  .description("Send a file/dir. DTLS by default; enable post-quantum mode with --pq.")
  .argument("<paths...>", "File(s) or directory to send; or '-' for stdin.")
  .option("--relay <wsUrl>", "Signaling relay (ws[s]://...).")
  .option("--api <httpUrl>", "Rendezvous HTTP API base (http[s]://...).")
  .option("--headers <json>", "JSON object with custom HTTP headers.", JSON.parse)
  .option("--app <uuid>", "Rendezvous appID (skip creating a code).")
  .option("--name <string>", "Override filename announced to receiver.", nonEmpty)
  .option("--stdin-name <string>", "Filename to announce when sending from stdin.", "stdin.bin")
  .option("--size <bytes>", "Required when sending from stdin.", parseIntStrict)
  .option("--pq", "Post-quantum mode (sender decides).", false)
  .option("-y, --yes", "Assume yes for SAS prompt.", false)
  .option("-v, --verbose", "Increase verbosity (repeatable).", (v, total) => total + 1, 0)
  .option("-q, --quiet", "Suppress non-error logs.", false)
  .option("--json", "Emit JSON logs on stderr.", false)
  .action(async (paths, opts) => {
    const { api, relay, headers } = resolveCfg({ relay: opts.relay, api: opts.api, headers: opts.headers });
    const cfg = { api, relay, headers };
    const logger = createLogger({
      level: opts.quiet ? "error" : (opts.verbose >= 1 ? "debug" : "info"),
      json: !!opts.json,
    });
    setGlobalLogger(logger);

    // Create rendezvous (unless --app was specified)
    let appID = opts.app;
    let code = null;
    if (!appID) {
      // Keep 'ttl' to match your server API (your logs showed { ttl: 600 }).
      const res = await createCode({ apiBase: cfg.api, ttl: 600, headers: cfg.headers });
      if (!res?.appID || !res?.code) throw new Error("send: failed to create rendezvous code");
      appID = res.appID;
      code = res.code;

      const displayCode = opts.pq ? `${code}-pq` : code;
      console.error(`Code: ${displayCode}`);
      console.error(`  nt ${displayCode}`);
      if (cfg.relay) console.error(`  nt recv --code ${displayCode} --relay ${cfg.relay}`);
    }

    await ensureRTC();

    try {
      await validateSendOptions(paths, opts);
      await Send.run(
        paths,
        {
          app: appID,
          relay: cfg.relay,
          headers: cfg.headers,
          pq: !!opts.pq,   // sender decides
          yes: !!opts.yes,
          name: opts.name,
          stdinName: opts.stdinName,
          size: opts.size,
        },
        { logger }
      );
      process.exit(EXIT.OK);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error(e.stack || e.message || String(e));
      process.exit(mapErrorToExitCode(e));
    }
  });

/* ------------------------------- entrypoint ------------------------------ */

async function main() {
  try {
    await program.parseAsync();
  } catch (e) {
    console.error(e?.stack || e);
    process.exit(1);
  }
}
main();
