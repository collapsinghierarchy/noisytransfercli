export function getIceConfig() {
  try {
    const raw = process.env.NT_ICE;
    if (!raw) return {};
    const cfg = JSON.parse(raw);
    // Allow bare array form: NT_ICE='[{"urls":"stun:..."}]'
    return Array.isArray(cfg) ? { iceServers: cfg } : cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}
