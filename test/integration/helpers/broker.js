// Starts scripts/ws-broker.js and waits until rendezvous answers.
// Kills it on cleanup.
import { spawn } from "node:child_process";

export async function startBroker({ port = 1234, env = {} } = {}) {
  const child = spawn(process.execPath, ["scripts/ws-broker.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROKER_PORT: String(port), ...env },
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // Poll the rendezvous until it replies OK
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 7000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/rendezvous/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ttl: 60 }),
      });
      if (r.ok) return { child, base };
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    child.kill("SIGKILL");
  } catch {}
  throw new Error(`broker did not start: ${lastErr?.message || lastErr}\n${stderr}`);
}

export async function stopBroker(proc) {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {}
}
