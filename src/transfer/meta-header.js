// [ 4 bytes magic = 'N' 'T' 'M' '1' ] [ 1 byte nameLen ] [ name UTF-8 bytes ]
export const META_MAGIC = Buffer.from([0x4e, 0x54, 0x4d, 0x31]); // "NTM1"

export function buildMetaHeader(name) {
  const n = Buffer.from(String(name), "utf8").slice(0, 255);
  const out = Buffer.alloc(5 + n.length);
  META_MAGIC.copy(out, 0);
  out[4] = n.length;
  n.copy(out, 5);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

export function stripMetaHeader(u8) {
  const b = Buffer.isBuffer(u8) ? u8 : Buffer.from(u8);
  if (b.length >= 5 && b.subarray(0, 4).equals(META_MAGIC)) {
    const len = b[4];
    if (b.length >= 5 + len) {
      const name = b.subarray(5, 5 + len).toString("utf8");
      const rest = b.subarray(5 + len);
      return { name, data: new Uint8Array(rest.buffer, rest.byteOffset, rest.length) };
    }
  }
  return null;
}
