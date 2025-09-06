// src/core/signal-helpers.js

// Wait until the signaling WebSocket is OPEN (works with our ws-adapter or raw ws)
export function waitSignalOpen(signal, ms = 10000) {
  const ws = (signal && (signal.raw || signal.ws || signal.socket)) || signal;
  return new Promise((resolve, reject) => {
    try {
      if (ws && typeof ws.readyState === "number" && ws.readyState === 1) return resolve(); // OPEN
      const to = setTimeout(() => reject(new Error("signal ws open timeout")), ms);

      const onOpen = () => {
        clearTimeout(to);
        cleanup();
        resolve();
      };
      const onErr = (e) => {
        clearTimeout(to);
        cleanup();
        reject(e);
      };
      const onOpenEvt = () => onOpen();
      const onErrEvt = (e) => onErr(e);

      function cleanup() {
        try {
          if (ws?.removeEventListener) {
            ws.removeEventListener("open", onOpenEvt);
            ws.removeEventListener("error", onErrEvt);
          } else {
            ws?.off?.("open", onOpenEvt);
            ws?.off?.("error", onErrEvt);
          }
        } catch {}
      }

      if (ws?.addEventListener) {
        ws.addEventListener("open", onOpenEvt);
        ws.addEventListener("error", onErrEvt);
      } else if (ws?.on) {
        ws.on("open", onOpenEvt);
        ws.on("error", onErrEvt);
      } else {
        // last resort
        clearTimeout(to);
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

// Turn “hangs” into actionable errors
export function withTimeout(promise, ms, label = "operation") {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      }
    );
  });
}

// Wait until we see a peer presence (hello) or any RTC frame from the other side.
export function waitForPeer(signal, { timeoutMs = 30000, debugLabel = "" } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        off1();
        off2();
      } catch {}
    };

    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          `peer did not appear within ${timeoutMs}ms${debugLabel ? ` (${debugLabel})` : ""}`
        )
      );
    }, timeoutMs);

    // Presence frame
    const off1 = signal.onMessage?.((m) => {
      if (m && m.type === "hello") {
        clearTimeout(timer);
        finish();
        resolve();
      }
    });

    // Fallback: if any RTC frame arrives, peer is obviously there
    const off2 = signal.onMessage?.((m) => {
      if (m && (m.type === "offer" || m.type === "answer" || m.type === "ice")) {
        clearTimeout(timer);
        finish();
        resolve();
      }
    });
  });
}

// src/core/signal-helpers.js
export function waitFor(signal, predicate, { timeoutMs = 30000, label = "" } = {}) {
  return new Promise((resolve, reject) => {
    let off;
    const timer = setTimeout(() => {
      off?.();
      reject(new Error(`timeout waiting${label ? " for " + label : ""} (${timeoutMs}ms)`));
    }, timeoutMs);

    off = signal.onMessage?.((m) => {
      try {
        if (predicate(m)) {
          clearTimeout(timer);
          off?.();
          resolve(m);
        }
      } catch (_) {}
    });
  });
}

export function waitForRoomFull(signal, opts) {
  return waitFor(signal, (m) => m && m.type === "room_full", {
    label: "room_full",
    ...(opts || {}),
  });
}
