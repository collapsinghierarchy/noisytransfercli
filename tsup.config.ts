import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "index": "src/index.ts",       // (create a tiny re-export; see §2.3)
    "nt": "src/cli.js"             // CLI entry – bundled to nt.mjs/nt.cjs
  },
  format: ["esm", "cjs"],
  target: "node18",
  sourcemap: true,
  clean: true,
  dts: { entry: { index: "src/index.ts" } },
  banner: {
    js: `#!/usr/bin/env node`
  },
  splitting: false,  // simpler for pkg/nexe later
  shims: false,
  minify: false
});
