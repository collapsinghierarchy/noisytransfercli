# NoisyTransfer CLI (nt)

Default mode: **DTLS over WebRTC DataChannel** (non-PQ).  
Optional: **PQ app-layer E2EE** with HPKE via `--pq`.  
Rendezvous via short human-readable codes.  
Works behind NATs; (In the Future: falls back to WebSocket signaling only for setup.)

---

## Install

- **npm (global)**
  ```bash
  npm i -g noisytransfer-cli
  ```
  > Requires Node 18+.

- **Single-file binaries (with WebRTC bundled)**  
  Download `nt-rtc` for your platform from GitHub Releases (TBD).  
  These builds include a pinned Node runtime and `@roamhq/wrtc`.

- **Docker (optional)**
  ```bash
  docker run --rm -it ghcr.io/yourorg/noisytransfer-cli:latest --help
  ```

---

## Quick start

1) Start (or use) your relay/API. Example:
   - WS relay: `wss://relay.example/ws`
   - API base: `https://relay.example`

2) **Send** a file:
   ```bash
   nt --relay wss://relay.example/ws send ./bigfile.iso
   ```
   Output:
   ```
   Code: olive-sun-93
   Expires: 2025-08-29T12:34:56Z

   Receiver can run either:
     nt olive-sun-93
     nt recv - --code olive-sun-93 --relay wss://relay.example/ws
   ```

3) **Receive** using the code:
   ```bash
   nt olive-sun-93
   ```
   If the stream is a multi-file archive, you’ll be prompted to provide an output directory (or use `nt recv ./out --code olive-sun-93`).

---

## PQ mode (HPKE over the stream)

Enable end-to-end encryption at the application layer with HPKE via your `@noisytransfer/crypto` + `@noisytransfer/noisystream`:

```bash
# Sender
nt --pq send ./secret.pdf
# Receiver (shortcut)
nt --pq <code>
# Receiver (explicit)
nt recv ./out --pq --code <code> --relay wss://relay.example/ws
```

- The SAS/auth handshake uses **NoisyAuth** with PQ-specific messages (HPKE pubkey / RSA-PSS verify key).
- Transfer uses **NoisyStream** helpers under that authenticated context.
- The relay/signaling server cannot read payloads.

---

## Usage

### Single-command receive
```bash
nt [--pq] <code>
```
- Equivalent to: `nt recv - [--pq] --code <code>`
- To avoid leaking the code in `ps` / shell history:
  ```bash
  NT_SECRET=<code> nt [--pq]
  ```

### Send
```bash
nt [--pq] send <pathOr-> [morePaths...] [--exclude "<glob1,glob2>"] [--sign]
```
- `-` means stdin.
- Multiple files/dirs are packed on the fly into a streaming **TAR**.
- `--exclude` filters files within directories (POSIX globs; `dot` files included).
- `--sign` adds an end-of-stream signature for extra integrity UX (on top of DTLS path).

### Receive
```bash
nt [--pq] recv [outPathOr-] [--code <code> | --app <uuid>] [--out <dir>] [--yes|--overwrite]
```
- If the stream is a TAR archive, use `--out <dir>` (or pass a directory as `outPathOr-`).
- Without `--out`, a raw stream defaults to stdout (or `received.bin` in the target dir).
- `--yes` implies `--overwrite` and suppresses overwrite prompts.

### Rendezvous (backend)
- Sender calls `POST /rendezvous/code` → `{ code, appID, expiresAt }`.
- Receiver calls `POST /rendezvous/redeem { code }` → `{ status, appID }`.
- Both then connect to `GET /ws?appID=...&side=A|B` for WebRTC signaling.

---

## Flags & environment

- `--relay <url>` – WebSocket signaling URL (default: `$NT_RELAY` or `wss://your-relay.example/ws`)
- `--api <url>` – HTTP API base (default: derived from `--relay` or `$NT_API_BASE`)
- `--pq` – enable HPKE app-layer E2EE using @noisytransfer/crypto + @noisytransfer/noisystream
- `--code-ttl <sec>` – code expiry for `send` (default: `$NT_CODE_TTL_SEC` or 600)
- `--exclude "<globs>"` – exclude globs for directory/multi-file send
- `--out <dir>` – output directory for archives
- `--yes`, `--overwrite` – overwrite behavior on receive
- `--sign` – add/expect end-of-stream signature (DTLS path)

**Environment knobs**
- `NT_RELAY` – default `--relay`
- `NT_API_BASE` – default `--api`
- `NT_SECRET` – receive code via env (privacy-friendly)
- `NT_SOCKS5` – route WebSocket via SOCKS5 (e.g. `127.0.0.1:9050`)
- `NT_ICE` – JSON array of ICE servers (e.g. `'[{"urls":"stun:stun.l.google.com:19302"}]'`)
- `NT_DEBUG=1` – extra logs for RTC dialing/fingerprints

---

## Security model

- Default: **DTLS** (WebRTC DataChannel).
- With `--pq`: app-layer E2EE via HPKE (relay cannot read, even if DTLS were compromised).
- Rendezvous code: **not an auth secret**; it maps to a room (`appID`).

---

## CLI: Local development quickstart

You can run the CLI against a [local dev server](https://github.com/collapsinghierarchy/noisytransfer).

### 1) Start the backend in dev mode
```bash
NT_DEV=1 ./noisytransferd \
  -addr :1234 \
  -base http://127.0.0.1:1234 \
  -cors "http://127.0.0.1,http://localhost"
```

### 2) Run the CLI (sender & receiver)
In two terminals:

**Receiver**
```bash
NT_RELAY=ws://127.0.0.1:1234/ws \
nt recv
```

**Sender**
```bash
NT_RELAY=ws://127.0.0.1:1234/ws \
nt send ./path/to/file.txt
```

The CLI will:
1) `POST /rendezvous/code` to mint `{ appID, code }`,
2) connect `ws://127.0.0.1:1234/ws?appID=<uuid>&side=A|B`,
3) negotiate WebRTC and stream the file over a data channel.

### 3) Optional: ICE (STUN/TURN)
If peers sit behind NAT, provide ICE servers:
```bash
NT_ICE='[{"urls":"stun:stun.l.google.com:19302"}]' \
NT_RELAY=ws://127.0.0.1:1234/ws \
nt send ./file.txt
```

### Troubleshooting
- **401/403/429 on WS**: ensure `appID` is present (CLI handles this) and backoff a bit on reconnect if you hit 429.
- **TLS errors**: use `ws://` locally; `wss://` requires valid certs.
- **Origin**: Node clients may omit `Origin`; in dev mode the server accepts it.

---

## License

AGPL-3.0-only
