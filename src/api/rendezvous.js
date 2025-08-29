/**
 * Rendezvous API client for the CLI.
 * Talks to backend:
 *   - POST /rendezvous/code   -> { code, appID, expiresAt }
 *   - POST /rendezvous/redeem -> { status, appID?, expiresAt? }
 *
 * It derives the HTTP(S) base URL from the WebSocket relay URL:
 *   ws://host:1234/ws  -> http://host:1234
 *   wss://host/ws      -> https://host
 *
 * You can override with:
 *   - NT_API_BASE (env)
 *   - or an explicit apiBase passed from the CLI --api flag
 */

const DEFAULT_TIMEOUT_MS = 10_000;

function relayToApiBase(relayUrl) {
  const u = new URL(relayUrl);
  const proto = (u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol);
  return `${proto}//${u.host}`;
}

/**
 * Small fetch wrapper with timeout and JSON body.
 * Note: Node 18+ has global fetch.
 */
async function postJSON(url, body, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);
  const composite = signal
    ? new AbortSignalAny([signal, controller.signal])
    : controller.signal;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: composite
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AbortSignalAny: minimal polyfill to combine signals.
 * If any signal aborts, the returned signal aborts.
 */
class AbortSignalAny {
  constructor(signals) {
    const c = new AbortController();
    const onAbort = (evt) => c.abort(evt?.target?.reason);
    for (const s of signals) {
      if (!s) continue;
      if (s.aborted) { c.abort(s.reason); break; }
      s.addEventListener("abort", onAbort, { once: true });
    }
    this.signal = c.signal;
  }
  get aborted() { return this.signal.aborted; }
  get reason() { return this.signal.reason; }
  addEventListener(...a) { this.signal.addEventListener(...a); }
  removeEventListener(...a) { this.signal.removeEventListener(...a); }
}

/** Resolve the API base URL from explicit override, env, or the relay URL. */
function resolveApiBase({ relay, apiBase }) {
  if (apiBase) return apiBase;
  if (process.env.NT_API_BASE) return process.env.NT_API_BASE;
  return relayToApiBase(relay);
}

/** Create a new human-readable code and its appID on the server. */
export async function createCode({ relay, apiBase, ttlSec, signal, timeoutMs } = {}) {
  const base = resolveApiBase({ relay, apiBase });
  const url = `${base}/rendezvous/code`;
  const resp = await postJSON(url, { ttlSec }, { signal, timeoutMs });
  if (!resp || !resp.code || !resp.appID) {
    throw new Error(`Bad response from server: ${JSON.stringify(resp)}`);
  }
  return resp; // { code, appID, expiresAt }
}

/** Redeem a human-readable code to get the appID. */
export async function redeemCode({ relay, apiBase, code, signal, timeoutMs } = {}) {
  const base = resolveApiBase({ relay, apiBase });
  const url = `${base}/rendezvous/redeem`;
  const resp = await postJSON(url, { code }, { signal, timeoutMs });
  if (!resp || !resp.status) {
    throw new Error(`Bad response from server: ${JSON.stringify(resp)}`);
  }
  return resp; // { status, appID?, expiresAt? }
}

/** Format the receiver commands for display (short + explicit). */
export function formatReceiverCommand({ code, relay, apiBase }) {
  const short = `nt ${code}`;
  const explicitParts = [`nt recv - --code ${code}`, `--relay ${relay}`];
  if (apiBase) explicitParts.push(`--api ${apiBase}`);
  const explicit = explicitParts.join(" ");
  return { short, explicit };
}
