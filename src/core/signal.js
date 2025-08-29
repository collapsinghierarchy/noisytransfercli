/**
 * Signaling client for WebRTC:
 * - wraps the WS reconnect helper from @noisytransfer/transport
 * - queues outbound messages until the socket is up
 * - exposes a minimal interface expected by rtcInitiator/rtcResponder:
 *     { send, onMessage, onClose, close }
 *
 * Query params:
 *   /ws?appID=<uuid>&side=A|B[&token=...]
 */

import { browserWSWithReconnect } from "@noisytransfer/transport";

/**
 * @param {string} relay   WebSocket base URL, e.g. wss://relay.example/ws
 * @param {string} appID   Room/app UUID returned by /rendezvous/code or /redeem
 * @param {"A"|"B"} side   A = sender/initiator, B = receiver/responder
 * @param {object} [options]
 * @param {number} [options.maxRetries=10]
 * @param {string} [options.token]    // if your backend requires an auth token
 */
export function createSignalClient(relay, appID, side, options = {}) {
  const url = new URL(relay);
  url.searchParams.set("appID", appID);
  url.searchParams.set("side", side);
  if (options.token) url.searchParams.set("token", options.token);

  const wsTx = browserWSWithReconnect(url.toString(), {
    maxRetries: options.maxRetries ?? 10,
    // you can add jitter/backoff options here if your helper supports them
  });

  // simple outbox to buffer messages until connected
  const outQ = [];
  const flush = () => {
    while (outQ.length && wsTx.isConnected) {
      const m = outQ.shift();
      try { wsTx.send(m); }
      catch { outQ.unshift(m); break; }
    }
  };
  wsTx.onUp(flush);

  return {
    /** send a signaling message (offer/answer/ice) */
    send: (m) => {
      if (wsTx.isConnected) wsTx.send(m);
      else outQ.push(m);
    },
    /** subscribe to signaling messages from the peer */
    onMessage: (cb) =>
      wsTx.onMessage((msg) => {
        if (!msg || typeof msg !== "object") return;
        switch (msg.type) {
          case "offer":
          case "answer":
          case "ice":
            cb(msg);
            break;
          default:
            // ignore other server messages
            break;
        }
      }),
    /** subscribe to close event */
    onClose: (cb) => wsTx.onClose(cb),
    /** close the underlying socket (and clear any queued messages) */
    close: (...a) => {
      outQ.length = 0;
      wsTx.close(...a);
    },
    /** optional: expose connectivity (useful for tests/logging) */
    get isConnected() { return wsTx.isConnected; },
    onUp: (cb) => wsTx.onUp(cb),
  };
}
