// src/transfer/default.js
// Implement DTLS mode with explicit frames (INIT/DATA/FIN) to match the auth_dtls_integration test.
import { createAuthSender, createAuthReceiver } from "@noisytransfer/noisyauth";
import { NoisyError } from "@noisytransfer/errors";
import { confirmPrompt } from "../core/sas-prompt.js";
import { unb64u as b64uToBytes } from "@noisytransfer/util";
import { buildMetaHeader, stripMetaHeader } from "./meta-header.js";
import {
  STREAM,
  packStreamInit,
  packStreamData,
  packStreamFin,
  parseStreamInit,
  parseStreamData,
  parseStreamFin,
} from "@noisytransfer/noisystream/frames";

function hex16(u8) {
  return Buffer.from(u8).toString("hex").slice(0, 32);
}

/**
 * Try to read DTLS fingerprints for a short window; return null if not ready.
 * @returns {{local:{alg:string,bytes:Uint8Array},remote:{alg:string,bytes:Uint8Array}}|null}
 */
async function maybeGetFingerprints(rtc, timeoutMs = 2500) {
  const start = Date.now();
  for (;;) {
    let lf, rf;
    try { lf = rtc.getLocalFingerprint?.(); } catch {}
    try { rf = rtc.getRemoteFingerprint?.(); } catch {}
    if (lf?.bytes && rf?.bytes) return { local: lf, remote: rf };
    if (Date.now() - start >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function dtlsAuthSender(rtc, { sessionId, assumeYes = false } = {}) {
  const fps = await maybeGetFingerprints(rtc); // may be null; that's OK
  const fpLocal = fps?.local;

  await new Promise((resolve, reject) => {
    const opts = { policy: "rtc", sessionId };
    if (fpLocal?.bytes) opts.sendMsg = new Uint8Array(fpLocal.bytes);

    createAuthSender(
      rtc,
      {
        onSAS: (words) => {
          if (words) {
            console.error(
              `[SAS A] ${Array.isArray(words) ? words.join(" ") : String(words)}`
            );
          } else if (fpLocal?.bytes) {
            console.error(
              `[SAS A] DTLS fingerprint (first 16 bytes): ${hex16(fpLocal.bytes)}`
            );
          } else {
            if (process.env.NT_DEBUG) {
              console.error(
                "[NT_DEBUG] sender: DTLS fingerprints not available; proceeding with SAS-only confirmation"
              );
            }
          }
        },
        waitConfirm: async () =>
          assumeYes ||
          confirmPrompt(
            fpLocal
              ? "A: Do the SAS & DTLS fingerprint match on both sides?"
              : "A: Do the SAS codes match on both sides?"
          ),
        onDone: ({ msgR }) => {
          try {
            // If we used fingerprint exchange, verify it; otherwise skip.
            if (fpLocal && msgR) {
              const got =
                typeof msgR === "string" ? b64uToBytes(msgR) : new Uint8Array(msgR);
              let fpRemoteNow;
              try {
                fpRemoteNow = rtc.getRemoteFingerprint?.();
              } catch {}
              if (
                !fpRemoteNow?.bytes ||
                Buffer.compare(
                  Buffer.from(got),
                  Buffer.from(fpRemoteNow.bytes)
                ) !== 0
              ) {
                return reject(new Error("Receiver DTLS fingerprint mismatch"));
              }
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        },
        onError: reject,
      },
      opts
    );
  });
}

async function dtlsAuthReceiver(rtc, { sessionId, assumeYes = false } = {}) {
  const fps = await maybeGetFingerprints(rtc);
  const fpLocal = fps?.local;

  await new Promise((resolve, reject) => {
    const opts = { policy: "rtc", sessionId };
    if (fpLocal?.bytes) opts.recvMsg = new Uint8Array(fpLocal.bytes);

    createAuthReceiver(
      rtc,
      {
        onSAS: (words) => {
          if (words) {
            console.error(
              `[SAS B] ${Array.isArray(words) ? words.join(" ") : String(words)}`
            );
          } else if (fpLocal?.bytes) {
            console.error(
              `[SAS B] DTLS fingerprint (first 16 bytes): ${hex16(fpLocal.bytes)}`
            );
          } else {
            if (process.env.NT_DEBUG) {
              console.error(
                "[NT_DEBUG] receiver: DTLS fingerprints not available; proceeding with SAS-only confirmation"
              );
            }
          }
        },
        waitConfirm: async () =>
          assumeYes ||
          confirmPrompt(
            fpLocal
              ? "B: Do the SAS & DTLS fingerprint match on both sides?"
              : "B: Do the SAS codes match on both sides?"
          ),
        onDone: ({ msgS }) => {
          try {
            // If we used fingerprint exchange, verify it; otherwise skip.
            if (fpLocal && msgS) {
              const got =
                typeof msgS === "string" ? b64uToBytes(msgS) : new Uint8Array(msgS);
              let fpRemoteNow;
              try {
                fpRemoteNow = rtc.getRemoteFingerprint?.();
              } catch {}
              if (
                !fpRemoteNow?.bytes ||
                Buffer.compare(
                  Buffer.from(got),
                  Buffer.from(fpRemoteNow.bytes)
                ) !== 0
              ) {
                return reject(new Error("Sender DTLS fingerprint mismatch"));
              }
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        },
        onError: reject,
      },
      opts
    );
  });
}

// Convert Node streams to async iterables of Uint8Array
function toAsyncIterable(source) {
  if (source && typeof source[Symbol.asyncIterator] === "function") return source;
  if (source && typeof source.on === "function") {
    // Node Readable
    return (async function* () {
      for await (const chunk of source) {
        yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      }
    })();
  }
  throw new Error("Unsupported source type for defaultSend");
}

export async function defaultSend(
  rtc,
  { sessionId, source, totalBytes, onProgress, assumeYes = false, name }
) {
  await dtlsAuthSender(rtc, { sessionId, assumeYes });

  // 1) Announce stream (totalBytes exactly like the test)
  const total = Number(totalBytes);
  if (!Number.isFinite(total) || total <= 0)
    throw new Error("defaultSend: totalBytes must be a positive integer");
  const init = packStreamInit({ sessionId, totalBytes: total });
  rtc.send(init);

    // 1a) Optional filename: embed as first data frame (encrypted by DTLS)
    // [ 4 bytes magic = 'N' 'T' 'M' '1' ] [ 1 byte nameLen ] [ name UTF-8 bytes ]
  let seq = 0;
  if (name) {
    try {
      const header = buildMetaHeader(name);
      rtc.send(packStreamData({ sessionId, seq, chunk: header }));
      seq += 1;
    } catch {}
  }

  // 2) Stream data frames (ns_data)
  let sent = 0;
  for await (const chunk of toAsyncIterable(source)) {
    const u8 = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    if (!u8.byteLength) continue;
    rtc.send(packStreamData({ sessionId, seq, chunk: u8 }));
    sent += u8.byteLength;
    seq += 1;
    onProgress?.(Math.min(sent, total), total);
  }

  // 3) FIN with ok=true if sizes match, else ok=false
  const ok = sent === total;
  rtc.send(packStreamFin({ sessionId, ok }));

  // 4) Flush if supported (mirrors tests' "flush" semantics)
  if (typeof rtc.flush === "function") {
    try {
      await rtc.flush();
    } catch {}
  }
}

export async function defaultRecv(
  rtc,
  { sessionId, sink, onProgress, assumeYes = false }
) {
  await dtlsAuthReceiver(rtc, { sessionId, assumeYes });

  let announced = null; // announced totalBytes from INIT
  let written = 0; // bytes we’ve actually written
  let done = false;
  let metaSeen = false; // strip NTM1 once

  // queue to serialize writes
  let queue = Promise.resolve();
  let queueErr = null;
  const run = (fn) => {
    queue = queue.then(fn, fn).catch((e) => {
      queueErr = e;
    });
    return queue;
  };

  let resolveDone, rejectDone;
  const doneP = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const td = new TextDecoder();

  function toObjectMessage(m) {
    try {
      if (m == null) return null;
      if (typeof m === "object" && !(m instanceof Uint8Array) && !ArrayBuffer.isView(m)) return m;
      if (typeof m === "string") {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      }
      if (m instanceof Uint8Array || ArrayBuffer.isView(m)) {
        try {
          return JSON.parse(td.decode(m));
        } catch {
          return null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  const offMsg = rtc.onMessage?.((raw) => {
    const m = toObjectMessage(raw);
    if (!m) return;

    try {
      // INIT
      const init = safe(() => parseStreamInit(m));
      if (init && init.sessionId === sessionId) {
        announced = Number(init.totalBytes) || 0;
        if (process.env.NT_DEBUG)
          console.error(`[NT_DEBUG] recv INIT totalBytes=${announced}`);
        return;
      }

      // DATA
      const data = safe(() => parseStreamData(m));
      if (data && data.sessionId === sessionId) {
         let u8 = data.chunk instanceof Uint8Array ? data.chunk : new Uint8Array(data.chunk);
        if (!metaSeen) {
          const info = stripMetaHeader(u8);
          if (info) {
            metaSeen = true;
            // announce filename without touching totalBytes
            try { sink.info?.({ name: info.name }); } catch {}
            u8 = info.data; // write only payload portion
            if (process.env.NT_DEBUG) console.error("[NT_DEBUG] recv META name=", info.name);
          } else {
            metaSeen = true; // first data had no header; avoid re-checking later
          }
        }
        run(async () => {
          await sink.write(u8);
          written += u8.byteLength;
          if (
            process.env.NT_DEBUG &&
            (written % 4096 === 0 || (announced && written === announced))
          )
            console.error(`[NT_DEBUG] recv DATA written=${written}`);
          try {
            onProgress?.(written, announced || 0);
          } catch {}
        });
        return;
      }

      // FIN
      const fin = safe(() => parseStreamFin(m));
      if (fin && fin.sessionId === sessionId) {
        done = true;
        // wait for all prior writes to finish before comparing counts
        run(async () => {
          if (queueErr) throw queueErr;
        }).finally(() => {
          offMsg?.();
          if (announced != null && announced !== 0 && written !== announced) {
            if (process.env.NT_DEBUG)
              console.error(
                `[NT_DEBUG] recv FIN mismatch written=${written} announced=${announced}`
              );
            rejectDone(
              new NoisyError({
                code: "NC_SIZE_MISMATCH",
                message: "received bytes differ from announced totalBytes",
              })
            );
          } else if (fin.ok === false) {
            rejectDone(
              new NoisyError({ code: "NC_SENDER_FAIL", message: "sender reported failure" })
            );
          } else {
            resolveDone();
          }
        });
      }
    } catch (e) {
      queueErr = queueErr || e;
      rejectDone(
        e instanceof NoisyError
          ? e
          : new NoisyError({ code: "NC_PROTOCOL", message: "recv error", cause: e })
      );
    }
  });

  const offClose = rtc.onClose?.(() => {
    if (done) return;
    done = true;
    // also wait for pending writes on close
    run(async () => {
      if (queueErr) throw queueErr;
    }).finally(() => {
      offMsg?.();
      if (announced != null && announced !== 0 && written !== announced) {
        if (process.env.NT_DEBUG)
          console.error(
            `[NT_DEBUG] recv CLOSE mismatch written=${written} announced=${announced}`
          );
        rejectDone(
          new NoisyError({
            code: "NC_EOF",
            message: "transport closed before receiving all bytes",
          })
        );
      } else {
        resolveDone();
      }
    });
  });

  let success = false;
  try {
    await doneP;
    success = true;
  } finally {
    offClose?.();
    // FIN-ack on success (lets sender wait before teardown)
    if (success) {
      try {
        rtc.send(packStreamFin({ sessionId, ok: true }));
      } catch {}
    }
  }
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
