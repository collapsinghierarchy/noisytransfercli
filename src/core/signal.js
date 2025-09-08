import WS from "ws";
import { browserWSWithReconnect } from "@noisytransfer/transport";

/**
 * Signaling client for rtcInitiator/rtcResponder.
 * Exposes: send(frame), onMessage(cb), onClose(cb), close(), waitOpen(ms), raw shim.
 */
export function createSignalClient({ relayUrl, appID, side = "A", headers } = {}) {
  if (!relayUrl) throw new Error("createSignalClient: relayUrl required");
  if (!appID) throw new Error("createSignalClient: appID required");
  if (side !== "A" && side !== "B") {
    throw new Error(`createSignalClient: invalid side '${side}', expected 'A' or 'B'`);
  }

  const url = `${String(relayUrl).replace(/\/$/, "")}?appID=${encodeURIComponent(
    appID
  )}&side=${encodeURIComponent(side)}`;

  if (process.env.NT_DEBUG) {
    console.error("[NT_DEBUG] signaling url:", url, "(role:", side, ")");
  }

  // Allow custom headers in Node by wrapping the WS ctor.
  const wsCtor =
    headers && Object.keys(headers).length
      ? function WithHeaders(u, protocols) {
          return new WS(u, protocols, { headers });
        }
      : WS;

  const ws = browserWSWithReconnect(url, {
    wsConstructor: wsCtor,
    protocols: undefined,
    // quick but reasonable backoff for tests/dev:
    backoffMs: [100, 250, 500, 1000, 2000],
    maxRetries: 6,
  });

  const msgListeners = new Set();
  const closeListeners = new Set();
  const sendQueue = [];

  // On connect: announce presence and flush queued frames.
  const offOpen = ws.onOpen(() => {
    if (process.env.NT_DEBUG) console.error("[NT_DEBUG] signal: open (side:", side, ")");
    try {
      ws.send({ type: "hello", side });
    } catch {}
    if (sendQueue.length) {
      for (const m of sendQueue.splice(0)) {
        try {
          ws.send(m);
        } catch {}
      }
    }
  });

  const offMsg = ws.onMessage((data) => {
    // IMPORTANT: browserWSWithReconnect already parsed JSON → we forward AS-IS.
    // Do not stringify/parse again.
    if (process.env.NT_DEBUG && data && typeof data === "object" && data.type) {
      try {
        // keep logs short
        const t = data.type;
        const k = t === "ice" ? "ice" : t;
        console.error("[NT_DEBUG] signal: recv type=", k);
      } catch {}
    }
    for (const fn of msgListeners) {
      try {
        fn(data);
      } catch {}
    }
  });

  const offClose = ws.onClose((ev) => {
    for (const fn of closeListeners) {
      try {
        fn(ev);
      } catch {}
    }
  });

  const transport = {
    // Send objects; wrapper will JSON.stringify internally (with binReplacer).
    send(frame) {
      if (ws.isConnected) {
        try {
          ws.send(frame);
        } catch {}
      } else {
        sendQueue.push(frame);
      }
    },
    onMessage(fn) {
      msgListeners.add(fn);
      return () => msgListeners.delete(fn);
    },
    onClose(fn) {
      closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
    async close(code = 1000, reason = "closed") {
      try {
        offOpen?.();
        offMsg?.();
        offClose?.();
      } catch {}
      try {
        ws.close(code, reason);
      } catch {}
    },
    async waitOpen(ms = 10000) {
      if (ws.isConnected) return;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("signal ws open timeout"));
        }, ms);
        const un1 = ws.onOpen(() => {
          cleanup();
          resolve();
        });
        const un2 = ws.onUp?.(() => {
          cleanup();
          resolve();
        });
        function cleanup() {
          clearTimeout(timer);
          try {
            un1?.();
            un2?.();
          } catch {}
        }
      });
    },
    // Legacy DOM-like shim for any helper that expects addEventListener/readyState
    raw: {
      addEventListener(type, h) {
        if (type === "open") ws.onOpen(h);
        else if (type === "close") ws.onClose(h);
        else if (type === "message") ws.onMessage((d) => h({ data: d }));
        else if (type === "error") ws.onDown?.(h);
      },
      removeEventListener() {
        /* no-op */
      },
      get readyState() {
        return ws.isConnected ? 1 : 0;
      },
    },
  };

  return transport;
}
