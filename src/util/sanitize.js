// Produce a safe leaf filename (no paths), tolerating Windows quirks.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

export function sanitizeFilename(name, { fallback = "file.bin", maxLen = 255 } = {}) {
  if (typeof name !== "string") return fallback;

  // Strip directory components
  const base = name.split("/").pop().split("\\").pop();

  let cleaned = base.replace(ILLEGAL_CHARS, "_").trim();

  // Disallow trailing dots/spaces on Windows
  cleaned = cleaned.replace(/[ .]+$/g, "");

  if (!cleaned || WIN_RESERVED.test(cleaned)) cleaned = fallback;

  if (cleaned.length > maxLen) {
    const extIdx = cleaned.lastIndexOf(".");
    if (extIdx > 0 && extIdx < maxLen) {
      const basePart = cleaned.slice(0, Math.max(1, maxLen - (cleaned.length - extIdx)));
      cleaned = basePart + cleaned.slice(extIdx);
    } else {
      cleaned = cleaned.slice(0, maxLen);
    }
  }
  return cleaned;
}
