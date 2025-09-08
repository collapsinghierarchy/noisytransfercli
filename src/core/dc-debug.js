import { getLogger } from "../util/logger.js";

export function attachDcDebug(tx, { label = "dc", sessionId, onlyTypes } = {}) {
  if (typeof tx?.onMessage !== "function") return () => {};
  const filterType = Array.isArray(onlyTypes) && onlyTypes.length ? new Set(onlyTypes) : null;

  const un = tx.onMessage((m) => {
    try {
      if (!m || typeof m !== "object") return;
      if (sessionId && m.sessionId && m.sessionId !== sessionId) return;
      const t = m.type || (m.offer && "offer") || (m.reveal && "reveal") || "<?>";

      if (!filterType || filterType.has(t)) {
        // keep it one-line to avoid flooding test output
        getLogger().debug(`${label}: frame type=${t} sid=${m.sessionId ?? "?"}`);
      }
    } catch {}
  });
  return typeof un === "function" ? un : () => {};
}
