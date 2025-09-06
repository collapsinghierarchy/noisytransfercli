import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function mkTmpDir(prefix = "ntcli-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    dispose: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
