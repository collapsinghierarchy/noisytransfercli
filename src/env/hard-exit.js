export async function hardExitIfEnabled({ code = 0 } = {}) {
  if (!process.env.NT_HARD_EXIT) return false;
  // Give stdio a tick to flush
  try { await new Promise(r => setImmediate(r)); } catch {}
  // Exit *now* (skips wrtc finalizers that are crashing)
  // eslint-disable-next-line n/no-process-exit
  process.exit(code);
  return true; // not reached, but makes intent clear
}