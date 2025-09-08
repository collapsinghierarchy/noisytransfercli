# noisytransfer-cli

Fast E2EE WebRTC file transfer (DTLS by default, optional PQ) with human-readable pairing codes.

* DTLS by default; opt-in **post-quantum (PQ)** auth.
* Code-based rendezvous (no accounts, no servers beyond a lightweight relay).
* Single file, directory, or multiple paths (multi-path → `.tar` on the wire).
* Predictable, quiet CLI output (friendly banner + progress).
* **Structured logs** (`--json`) and `-v` debug stream (kept off stdout).
* Programmatic API + TypeScript types.
* Prebuilt binaries for Linux/macOS/Windows, or build from source.

## Install

### npm

```bash
npm i -g noisytransfer-cli
# or as a lib:
npm i noisytransfer-cli
```

### Binaries

Download from your releases (or build locally):

```bash
# local build
npm run build
npm run pkg
# binaries in ./release or ./dist (based on your scripts)
```

## Quick start

### Send

```bash
# send a file
nt send ./photo.jpg

# send multiple paths (bundled as .tar on the wire)
nt send report.pdf ./docs ./assets
```

You’ll see:

```
Code: 49b47940
  nt 49b47940
  nt recv --code 49b47940 --relay http://127.0.0.1:40971
```

### Receive

You can use **any** of the following:

```bash
# simplest: positional shorthand
nt 49b47940

# explicit command & code, default output = current dir
nt recv 49b47940

# or with an explicit output directory
nt recv ./downloads 49b47940

# or with the flag form
nt recv ./downloads --code 49b47940

# skip redeem if you already have the appID
nt recv ./downloads --app 49b47940-0cb1-43b3-bdb9-6f7f31f9a47d
```

To write to stdout:

```bash
nt recv - --code 49b47940 > received.bin
```

### Post-quantum (PQ) mode

Append `-pq` to the code or pass `--pq`:

```bash
# sender prints "Code: 5527e74d-pq"
nt send --pq ./big.iso

# receiver can use the suffix, or just --pq explicitly
nt recv ./downloads 5527e74d-pq
# or
nt recv ./downloads --code 5527e74d --pq
```

## Behavior & flags

* `--name <string>`: override the advertised filename (single stream).
* Multi-path sends are **tarred**; receiver writes `bundle.tar`. If a file exists and `--overwrite` is not set, the receiver dedupes as `bundle-1.tar`, `bundle-2.tar`, …
* `--overwrite`: replace existing file instead of deduping.
* `-y, --yes`: auto-accept SAS (useful for non-interactive invocations). Does **not** imply `--overwrite`.
* `--json`: JSON logs on stderr (all debug routed through the logger).
* `-v` (repeatable): increase verbosity; includes `[NT_DEBUG]` traces.
* Filenames are sanitized on the receiver (no path traversal / reserved names). Output directory is always the **receiver’s** choice.

## Logging

* Human-facing lines (stable for scripts/tests):

  * `Code: …`, `nt …` hints
  * `Receiving → …`
  * SAS lines: `[SAS A] …`, `[SAS B] …`
  * The two-column progress line
* Debug: `-v` or `NT_DEBUG=1` (on stderr).
* Structured: `--json` (each line is a JSON object on stderr).

Example:

```bash
nt send ./file -v --json 2> send.jsonl
```

## Programmatic API

```js
import { send, recv, createCode, redeemCode } from "noisytransfer-cli";

// receive into ./downloads (auto-redeem code)
const r = await recv("./downloads", { relay: "http://127.0.0.1:40971", yes: true, code: "49b47940" });
// r = { bytesWritten, announcedBytes, label, path, mode, appID }

await send(["./file.txt"], { relay: "http://127.0.0.1:40971", yes: true });
```

TypeScript types are included. Key shapes:

```ts
type Mode = "dtls" | "pq";

interface CommonOpts { relay?: string; headers?: Record<string,string>; pq?: boolean; yes?: boolean; }
interface SendOptions extends CommonOpts { app?: string; name?: string; stdinName?: string; size?: number; }
interface RecvOptions extends CommonOpts { app?: string; overwrite?: boolean; }

interface RecvResult {
  bytesWritten: number; announcedBytes: number;
  label: string | null; path: string | null; mode: Mode; appID: string;
}
```

## Build from source

Requirements: Node 18+.

```bash
# install (generates package-lock if missing)
npm install

# tests
npm test

# build JS bundles + types
npm run build

# make standalone binaries (Linux/macOS/Windows)
npm run pkg
```

If your CI uses `npm ci`, commit `package-lock.json`:

```bash
npm i --package-lock-only
git add package-lock.json
git commit -m "chore: lockfile"
```

## Security model (short)

* Transport is WebRTC datachannel (DTLS). PQ mode wraps auth with a KEM-based handshake and SAS confirmation.
* Rendezvous codes are short-lived; both sides display a 6-digit SAS you can compare out-of-band.
* The receiver owns the destination directory; announced filenames are sanitized to safe **leaf** names.

## Troubleshooting

* **“recv: either --code or --app is required”** – pass a code: `nt recv ./out --code <8-hex>` or just `nt <code>`.
* **NAT / firewalls** – set `--relay` to your reachable rendezvous service.
* **Windows** – native WebRTC addon is embedded; if you build locally, ensure the `.node` is present in `assets/native/win32-*` (your scripts copy these into `dist/assets/native/...` for the binary).
* **Lockfile/CI** – use `npm ci` only when `package-lock.json` is committed.

## License

AGPL-3.0-only
