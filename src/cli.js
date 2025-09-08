#!/usr/bin/env node
// Load env/polyfills (crypto, ws, socks, WebRTC) exactly once
import "./env/node-polyfills.js";

import { Command, InvalidOptionArgumentError } from "commander";
import { createCode, redeemCode } from "./api/rendezvous.js";
import { resolveCfg } from "./config/resolve.js";
import { ensureRTC } from "./env/rtc-init.js";

// subcommand handlers
import * as Send from "./commands/send.js";
import * as Recv from "./commands/recv.js";

function nonEmpty(v) {
  if (!v || String(v).trim() === "") throw new InvalidOptionArgumentError("must not be empty");
  return v;
}
function parseIntStrict(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new InvalidOptionArgumentError("must be a non-negative integer");
  return n;
}

// Parse a user-facing code that may carry a PQ suffix.
// Returns { pq: boolean, code: string (clean, without suffix) }
function parseModeFromCode(input) {
  const s = String(input || "").trim();
  // Accept "-pq", ".pq", "_pq", "+pq" (case-insensitive)
  const m = s.match(/^(.*?)(?:[.\-+_])?pq$/i);
  if (m) return { pq: true, code: m[1] || "" };
  return { pq: false, code: s };
}

// ---------------------------------------------------------------------------
// Shorthand: `nt <code>` → `nt recv --code <code>` (no --relay required)
// We accept 4–12 lowercase letters by default (tweak if your codes differ).
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const KNOWN = new Set(["send", "recv", "help", "version", "-h", "--help", "-V", "--version"]);
const looksLikeCode = (s) => typeof s === "string" && /^[a-z]{4,12}$/.test(s);
if (argv.length >= 1 && !argv[0]?.startsWith("-") && !KNOWN.has(argv[0]) && looksLikeCode(argv[0])) {
  const code = argv[0];
  if (argv.length === 1) {
    process.argv.splice(2, process.argv.length, "recv", "--code", code);
  } else if (argv.length === 2 && !argv[1].startsWith("-")) {
    // support: nt <code> <outDir>
    process.argv.splice(2, process.argv.length, "recv", "--code", code, argv[1]);
  }
  // else: don’t rewrite if extra flags are present (ambiguous)
}

// Commander setup
const program = new Command();
program
  .name("nt")
  .description("noisytransfer CLI")
  .version("0.0.0"); // bundler replaces this

// ---------------------------------------------------------------------------
// RECV
// ---------------------------------------------------------------------------
program
  .command("recv")
  .description("receive files (DTLS default; use --pq for PQ mode)")
  .argument("[outDir]", "output directory (use '-' for stdout)", ".")
  .option("--code <code>", "rendezvous short code")
  .option("--app <uuid>", "rendezvous appID (skips code redeem)")
  .option("--relay <wsUrl>", "signaling relay (ws[s]://...)")
  .option("--api <httpUrl>", "rendezvous HTTP API base (http[s]://...)")
  .option("--headers <json>", "JSON object with custom HTTP headers", JSON.parse)
  .option("-y, --yes", "assume yes for prompts / overwrite", false)
  .option("--overwrite", "force overwrite of existing files", false)
  .action(async (outDir, opts) => {
    const { api, relay, headers } = resolveCfg({ relay: opts.relay, api: opts.api, headers: opts.headers });
    const cfg = { api, relay, headers };
    // Either --app or --code must be provided. If code is present, redeem to appID.
    let appID = opts.app;
    if (!appID) {
      if (!opts.code) {
        throw new Error("recv: either --code or --app is required");
      }
      const { pq: pqFromCode, code: cleanCode } = parseModeFromCode(opts.code);
      opts.pq = pqFromCode;
      const { appID: redeemed } = await redeemCode({ apiBase: cfg.api, code: cleanCode, headers: cfg.headers });
      appID = redeemed;
    }

    await Recv.run(outDir, {
      app: appID,
      relay: cfg.relay,
      headers: cfg.headers,
      pq: opts.pq,                 
      overwrite: !!opts.overwrite,
      yes: !!opts.yes,
    });
  });

// ---------------------------------------------------------------------------
// SEND
// ---------------------------------------------------------------------------
program
  .command("send")
  .description("send a file/dir (DTLS default; use --pq for PQ mode)")
  .argument("<paths...>", "file(s) or directory to send; or '-' for stdin")
  .option("--relay <wsUrl>", "signaling relay (ws[s]://...)")
  .option("--api <httpUrl>", "rendezvous HTTP API base (http[s]://...)")
  .option("--headers <json>", "JSON object with custom HTTP headers", JSON.parse)
  .option("--app <uuid>", "rendezvous appID (skips creating a code)")
  .option("--name <string>", "override filename announced to receiver")
  .option("--stdin-name <string>", "filename to announce when sending from stdin", "stdin.bin")
  .option("--size <bytes>", "required when sending from stdin", parseIntStrict)
  .option("--pq", "post-quantum mode", false)
  .option("-y, --yes", "assume yes for SAS prompt", false)
  .action(async (paths, opts) => {
    const { api, relay, headers } = resolveCfg({ relay: opts.relay, api: opts.api, headers: opts.headers });
    const cfg = { api, relay, headers };

    // Create rendezvous (unless --app was specified)
    let appID = opts.app;
    let code = null;
    if (!appID) {
      const res = await createCode({ apiBase: cfg.api, ttl: 600, headers: cfg.headers });
      appID = res.appID;
      code = res.code;
      const displayCode = opts.pq ? `${code}-pq` : code;
      console.error(`Code: ${displayCode}`);
      console.error(`  nt ${displayCode}`);
      // Friendly banner
     if (opts.relay) {
       console.error(`  nt recv --code ${displayCode} --relay ${cfg.relay}`);
     }
    }

    // Ensure native RTC backend is initialized early (optional; dialRTC also ensures this)
    await ensureRTC();

    await Send.run(paths, {
      app: appID,
      relay: cfg.relay,
      headers: cfg.headers,
      pq: !!opts.pq,
      yes: !!opts.yes,
      name: opts.name,
      stdinName: opts.stdinName,
      size: opts.size,
    });
  });

// default handler (show help if no args)
program
  .hook("preAction", () => {})
  .showHelpAfterError("(use --help for usage)");

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
