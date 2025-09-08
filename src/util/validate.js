import fs from "node:fs/promises";
import path from "node:path";

export class BadArgsError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "BadArgsError";
    this.code = "ERR_INVALID_ARG_VALUE";
  }
}

export function assertArg(cond, msg) {
  if (!cond) throw new BadArgsError(msg);
}

export async function validateSendOptions(paths, opts) {
  // at least one path or "-" (stdin)
  assertArg(Array.isArray(paths) && paths.length > 0, "send: missing input path(s)");

  const fromStdin = paths.length === 1 && paths[0] === "-";
  if (fromStdin) {
    assertArg(Number.isInteger(opts.size) && opts.size > 0, "send: --size must be a positive integer when reading from stdin");
  } else {
    // make sure each path exists
    await Promise.all(
      paths.map(async (p) => {
        const abs = path.resolve(p);
        try { await fs.stat(abs); } catch { throw new BadArgsError(`send: not found: ${p}`); }
      })
    );
  }

  if (opts.name) {
    assertArg(typeof opts.name === "string" && opts.name.trim().length > 0, "send: --name must be a non-empty string");
  }
}

export async function validateRecvOptions(outDir, opts) {
  assertArg(typeof outDir === "string", "recv: missing output");
  const toStdout = outDir === "-";

  if (toStdout) {
    // stdout incompatible flags
    assertArg(!opts.overwrite, "recv: --overwrite cannot be used with stdout");
  } else {
    // ensure dir exists and is a directory
    try {
      const st = await fs.stat(outDir);
      assertArg(st.isDirectory(), `recv: output must be a directory: ${outDir}`);
    } catch {
      throw new BadArgsError(`recv: output directory not found: ${outDir}`);
    }
  }
}
