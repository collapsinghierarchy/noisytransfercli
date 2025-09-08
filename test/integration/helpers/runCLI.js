import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { access, stat, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";

function pickBin() {
  const envBin = process.env.NT_BIN;
  if (envBin) return { cmd: envBin, args: [] };

  const pkgLinux = path.resolve("dist/nt-linux-x64");
  if (process.platform === "linux" && existsSync(pkgLinux)) return { cmd: pkgLinux, args: [] };

  const pkgCjs = path.resolve("build/pkg.cjs");
  const srcCli = path.resolve("src/cli.js");
  const entry = existsSync(pkgCjs) ? pkgCjs : srcCli;
  return { cmd: process.execPath, args: [entry] };
}

function tee(child, label) {
  if (!process.env.NT_DEBUG) return;
  const pfx = `[${label}] `;
  child.stderr?.on("data", (d) => process.stderr.write(pfx + d.toString()));
  child.stdout?.on("data", (d) => process.stderr.write(pfx + d.toString()));
}

export function runRecv({ code, outDir, api, relay, yes = true, extra = [] } = {}) {
  const { cmd, args } = pickBin();
  const argv = [
    ...args,
    "recv",
    ...(outDir ? [outDir] : []),
    "--code",
    code,
    ...(yes ? ["--yes"] : []),
    ...extra,
  ];
  const child = spawn(cmd, argv, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  tee(child, "recv");
  return child;
}

export function runSend({ paths, api, relay, yes = true, extra = [] } = {}) {
  const { cmd, args } = pickBin();
  const argv = [...args, "send", ...paths, ...(yes ? ["--yes"] : []), ...extra];
  const child = spawn(cmd, argv, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  tee(child, "send");
  return child;
}

export async function hashFile(p, algo = "sha256") {
  const h = createHash(algo);
  h.update(await fs.readFile(p));
  return h.digest("hex");
}

export function waitForLine(stream, pattern, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (pattern.test(line)) {
          stream.off("data", onData);
          resolve(line);
          return;
        }
      }
    };
    setTimeout(() => {
      stream.off("data", onData);
      reject(new Error(`timeout waiting for ${pattern}`));
    }, timeoutMs);
    stream.on("data", onData);
  });
}

export function waitExit(child, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const onExit = (code, signal) => {
      if (!done) {
        done = true;
        resolve({ code, signal });
      }
    };
    child.once("exit", onExit);
    setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        resolve({ code: null, signal: "SIGTERM" });
      }
    }, timeoutMs);
  });
}

export async function waitForOutputFile(dir, excludeNames = [], timeoutMs = 20000, stableMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let lastName = null,
    lastSize = -1,
    lastT = 0;
  while (Date.now() < deadline) {
    const names = (await readdir(dir)).filter((n) => !excludeNames.includes(n));
    if (names.length) {
      const stats = await Promise.all(
        names.map(async (n) => ({ n, st: await stat(path.join(dir, n)) }))
      );
      stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      const { n, st } = stats[0];
      if (n === lastName && st.size === lastSize) {
        if (Date.now() - lastT >= stableMs) return path.join(dir, n);
      } else {
        lastName = n;
        lastSize = st.size;
        lastT = Date.now();
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for output file in ${dir}`);
}

export function killHard(...children) {
  for (const c of children) {
    if (!c) continue;
    try {
      c.kill("SIGTERM");
    } catch {}
    try {
      c.kill("SIGKILL");
    } catch {}
  }
}
