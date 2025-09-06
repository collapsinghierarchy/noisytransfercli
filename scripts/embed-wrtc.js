// scripts/embed-wrtc.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const requireCJS = createRequire(import.meta.url);

// Resolve target (defaults to current host)
const TARGET_OS = process.env.TARGET_OS || process.platform; // linux|darwin|win32
const TARGET_ARCH = process.env.TARGET_ARCH || process.arch; // x64|arm64
const key = `${TARGET_OS}-${TARGET_ARCH}`;

const sidecarByTarget = {
  "linux-x64": "@roamhq/wrtc-linux-x64",
  "linux-arm64": "@roamhq/wrtc-linux-arm64",
  "darwin-x64": "@roamhq/wrtc-darwin-x64",
  "darwin-arm64": "@roamhq/wrtc-darwin-arm64",
  "win32-x64": "@roamhq/wrtc-win32-x64",
  "win32-arm64": "@roamhq/wrtc-win32-arm64",
};

const sidecarPkg = sidecarByTarget[key];
if (!sidecarPkg) {
  console.error(`[embed-wrtc] No sidecar mapping for ${key}`);
  process.exit(1);
}

// 1) Find the installed sidecar package directory (this verifies it's installed)
let pkgDir;
try {
  const pkgJson = requireCJS.resolve(`${sidecarPkg}/package.json`);
  pkgDir = path.dirname(pkgJson);
} catch {
  console.error(
    `[embed-wrtc] Sidecar package '${sidecarPkg}' is not resolvable from this project.`
  );
  console.error(`[embed-wrtc] Install it here:  npm i -D ${sidecarPkg}`);
  process.exit(1);
}

// 2) Locate wrtc.node inside the sidecar (search robustly)
function findFileRecursive(root, filename, maxDepth = 5) {
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === filename) return p;
      if (e.isDirectory()) stack.push({ dir: p, depth: depth + 1 });
    }
  }
  return null;
}

let src = findFileRecursive(pkgDir, "wrtc.node");
if (!src) {
  // As a fallback, try the main package's native build (helps in some installs)
  try {
    src = requireCJS.resolve("@roamhq/wrtc/build/Release/wrtc.node");
  } catch {}
}

if (!src || !fs.existsSync(src)) {
  console.error(
    `[embed-wrtc] Could not find wrtc.node in '${sidecarPkg}'. Looked under: ${pkgDir}`
  );
  process.exit(1);
}

// 3) Copy into assets/native/<os>-<arch>/wrtc.node
const dstDir = path.join(projectRoot, "assets", "native", key);
fs.mkdirSync(dstDir, { recursive: true });
const dst = path.join(dstDir, "wrtc.node");
fs.copyFileSync(src, dst);
console.log(`[embed-wrtc] Copied ${src} -> ${path.relative(projectRoot, dst)}`);
