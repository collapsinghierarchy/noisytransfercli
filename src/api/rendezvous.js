import { getLogger } from "../util/logger.js";

// Tolerant rendezvous client for dev/prod brokers.
//
// Accepts multiple response shapes:
//  - JSON: { code, appID } or { code } or { data: { code, appID } } etc.
//  - text/plain: "CODE", "code: CODE", or "CODE APPID"
// If appID is missing, we fall back to appID === code.
//
// Endpoints tried (first that succeeds wins):
//   create:  /rendezvous/code, /rendezvous/create, /code
//   redeem:  /rendezvous/redeem, /redeem, /code/redeem
//
// With NT_DEBUG=1, we log the HTTP status and first 200 chars of the body.

const debug = (...args) => getLogger().debug(args.join(" "));


function normApiBase(apiBase) {
  // Derive an http(s) origin from ws(s) if someone passed the relay by mistake.
  try {
    const u = new URL(apiBase);
    if (u.protocol === "ws:") u.protocol = "http:";
    if (u.protocol === "wss:") u.protocol = "https:";
    // Strip /ws suffix that often exists on the relay
    if (u.pathname.endsWith("/ws")) u.pathname = u.pathname.replace(/\/ws$/, "/");
    return u.toString().replace(/\/+$/, "");
  } catch {
    // As a last resort, assume http origin
    return `http://${apiBase}`.replace(/\/+$/, "");
  }
}

async function readBody(res) {
  const text = await res.text();
  debug("HTTP", res.status, res.statusText, "len", text.length, "body:", text.slice(0, 200));
  return text;
}

function sniffJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && typeof obj === "object" && obj[k] != null) return obj[k];
  }
  return undefined;
}

function extractCreate(text, res) {
  // Prefer JSON
  const j = sniffJson(text) || {};
  const code =
    pick(j, "code") ??
    pick(j.data || {}, "code") ??
    pick(j.result || {}, "code") ??
    pick(j, "id", "roomCode");
  let appID = pick(j, "appID", "appId", "app") ?? pick(j.data || {}, "appID") ?? undefined;

  if (!code) {
    // Try text/plain formats
    const trimmed = String(text || "").trim();
    if (trimmed) {
      const m = trimmed.match(/code\s*[:=]\s*([A-Za-z0-9._:-]+)/i);
      const c = m ? m[1] : trimmed.split(/\s+/)[0];
      const a = trimmed.split(/\s+/)[1];
      if (c) return { code: c, appID: a || c };
    }
    return null;
  }
  return { code, appID: appID || code };
}

function extractRedeem(text, res, code) {
  const j = sniffJson(text) || {};
  let appID = pick(j, "appID", "appId", "app") ?? pick(j.data || {}, "appID");
  if (!appID) {
    // Some brokers just 200 OK with no body; treat as success with appID=code
    const okish = res.status >= 200 && res.status < 300;
    if (okish) appID = code;
  }
  if (!appID) {
    // text/plain fallback: "APPID" or "ok" or "redeemed"
    const t = String(text || "").trim();
    if (t && !/^ok\b/i.test(t) && !/^redeemed\b/i.test(t)) appID = t.split(/\s+/)[0];
  }
  return appID ? { appID } : null;
}

async function postJson(url, body) {
  debug("POST", url, "body:", body);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await readBody(res);
  return { res, text };
}

export async function createCode({ relay, apiBase, ttlSec = 600 }) {
  const base = normApiBase(apiBase);
  const urls = [`${base}/rendezvous/code`, `${base}/rendezvous/create`, `${base}/code`];
  let lastErr = null;
  for (const url of urls) {
    try {
      const { res, text } = await postJson(url, { ttl: ttlSec });
      // Some brokers return 201; treat any 2xx as candidate
      if (res.status < 200 || res.status >= 300) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const out = extractCreate(text, res);
      if (out && out.code) {
        debug("createCode parsed:", out);
        return { status: "ok", ...out };
      }
      lastErr = new Error("unparsable body");
    } catch (e) {
      lastErr = e;
      debug("createCode attempt failed:", url, e?.message || e);
    }
  }
  if (lastErr) debug("createCode failed:", lastErr.message);
  return { status: "error", error: lastErr ? String(lastErr.message || lastErr) : "unknown" };
}

export async function redeemCode({ relay, apiBase, code }) {
  if (!code) return { status: "error", error: "missing code" };
  const base = normApiBase(apiBase);
  const urls = [`${base}/rendezvous/redeem`, `${base}/redeem`, `${base}/code/redeem`];

  let lastErr = null;
  for (const url of urls) {
    try {
      const { res, text } = await postJson(url, { code });
      if (res.status < 200 || res.status >= 300) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const out = extractRedeem(text, res, code);
      if (out && out.appID) {
        debug("redeemCode parsed:", out);
        return { status: "ok", code, ...out };
      }
      lastErr = new Error("unparsable body");
    } catch (e) {
      lastErr = e;
      debug("redeemCode attempt failed:", url, e?.message || e);
    }
  }
  if (lastErr) debug("redeemCode failed:", lastErr.message);
  return { status: "error", code, error: lastErr ? String(lastErr.message || lastErr) : "unknown" };
}

// Keep this helper (used by CLI to print the friendly recv hint)
export function formatReceiverCommand({ code, relay, apiBase }) {
  const short = `nt ${code}`;
  const explicit = `nt recv --code ${code} --relay ${relay}`;
  return { short, explicit };
}
