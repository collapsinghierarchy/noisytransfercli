import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

export async function startBroker({ port = 0 } = {}) {
  const ROOT = path.resolve(process.cwd());
  const SCRIPT = path.join(ROOT, "scripts", "ws-broker.js");

  const child = spawn(process.execPath, [SCRIPT, String(port)], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env },
  });

  // scripts/ws-broker.js prints: BROKER_PORT=<port>
  const rl = readline.createInterface({ input: child.stdout });
  const chosenPort = await new Promise((resolve, reject) => {
    const onLine = (line) => {
      const m = /^BROKER_PORT=(\d+)\s*$/.exec(line);
      if (m) {
        rl.off("line", onLine);
        resolve(Number(m[1]));
      }
    };
    rl.on("line", onLine);
    child.once("exit", (code) => reject(new Error(`broker exited early (code ${code})`)));
    child.once("error", reject);
  });

  const api = `http://127.0.0.1:${chosenPort}`;
  const relay = `ws://127.0.0.1:${chosenPort}/ws`;
  const close = () => { try { child.kill(); } catch {} };

  return { api, relay, port: chosenPort, close };
}

export async function stopBroker(env) {
  try { await env?.close?.(); } catch {}
}
