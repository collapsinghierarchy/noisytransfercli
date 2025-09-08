const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };

export function createLogger({ level = "info", json = false } = {}) {
  const L = LEVELS[level] ?? LEVELS.info;
  const log = (lvl, msg, meta) => {
    if (LEVELS[lvl] <= L) {
      if (json) {
        process.stderr.write(JSON.stringify({ lvl, msg, ...meta }) + "\n");
      } else {
        const tag = lvl === "debug" ? "[NT_DEBUG]" : "nt";
        process.stderr.write(`${tag} ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`);
      }
    }
  };
  return {
    error: (m, meta) => log("error", m, meta),
    info: (m, meta) => log("info", m, meta),
    debug: (m, meta) => log("debug", m, meta)
  };
}
