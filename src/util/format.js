// src/util/format.js
export function humanBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  const u = ["B", "KiB", "MiB", "GiB"];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}
export function formatETA(s) {
  if (!Number.isFinite(s) || s === Infinity) return "—";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
