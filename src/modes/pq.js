/**
 * PQ mode for the nt CLI using @noisytransfer crypto stack.
 *
 * Auth:
 *   - Sender advertises RSA-PSS verify key (SPKI) via @noisytransfer/crypto.genRSAPSS()
 *   - Receiver advertises HPKE public key via @noisytransfer/crypto.suite.kem
 * Transfer:
 *   - Delegates to @noisytransfer/noisystream sendFileWithAuth/recvFileWithAuth
 */

import { createAuthSender, createAuthReceiver } from "@noisytransfer/noisyauth";
import { sendFileWithAuth, recvFileWithAuth } from "@noisytransfer/noisystream";
import { suite, genRSAPSS } from "@noisytransfer/crypto";

/* ----------------------------- PQ Handshakes ------------------------------ */

export async function pqHandshakeSender(raw, { sessionId, onSAS, confirm = true } = {}) {
  const { verificationKey } = await genRSAPSS();              // Uint8Array (SPKI)
  const spki = new Uint8Array(verificationKey);

  await new Promise((resolve, reject) => {
    createAuthSender(
      raw,
      {
        onSAS: (s) => onSAS?.(s),
        waitConfirm: () => !!confirm,
        onDone: () => resolve(),
        onError: reject,
      },
      { policy: "rtc", sessionId, sendMsg: spki }
    );
  });
}

export async function pqHandshakeReceiver(raw, { sessionId, onSAS, confirm = true } = {}) {
  const kp = await suite.kem.generateKeyPair();
  const pub = await suite.kem.serializePublicKey(kp.publicKey);

  await new Promise((resolve, reject) => {
    createAuthReceiver(
      raw,
      {
        onSAS: (s) => onSAS?.(s),
        waitConfirm: () => !!confirm,
        onDone: () => resolve(),
        onError: reject,
      },
      { policy: "rtc", sessionId, recvMsg: new Uint8Array(pub) }
    );
  });
}

/* ------------------------------ File Transfer ----------------------------- */

export async function pqSendFile(raw, { sessionId, source, onProgress }) {
  await sendFileWithAuth({ tx: raw, sessionId, source, onProgress });
}

export async function pqRecvFile(raw, { sessionId, sink, onProgress }) {
  await recvFileWithAuth({ tx: raw, sessionId, sink, onProgress });
}
