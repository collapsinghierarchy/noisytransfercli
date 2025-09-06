import { b64u as b64url, unb64u as unb64url } from "@noisytransfer/util";

export function encodeLink({ room, sessionId, signalUrl, pq = false }) {
  const payload = { v: 1, r: room, s: sessionId, u: signalUrl, pq: !!pq };
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return `noisy:${b64url(json)}`;
}

export function decodeLink(link) {
  let tok = String(link || "").trim();
  if (tok.startsWith("noisy://")) {
    const u = new URL(tok);
    return {
      v: 1,
      r: u.searchParams.get("r"),
      s: u.searchParams.get("s"),
      u: u.searchParams.get("u"),
      pq: u.searchParams.get("pq") === "1",
    };
  }
  if (tok.startsWith("noisy:")) tok = tok.slice("noisy:".length);
  const u8 = unb64url(tok);
  const parsed = JSON.parse(new TextDecoder().decode(u8));
  if (!parsed || parsed.v !== 1) throw new Error("Invalid link payload");
  return { v: 1, r: parsed.r, s: parsed.s, u: parsed.u, pq: !!parsed.pq };
}
