import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.js",
    nt: "src/cli.js",      // <-- CLI entry
  },
  format: ["esm", "cjs"],   // index gets both; nt will get both too, but we’ll use the ESM
  target: "node18",
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  banner: { js: "#!/usr/bin/env node" } // keep ONLY this; remove any in-file shebang
});
