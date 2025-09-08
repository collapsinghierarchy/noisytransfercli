import { createTestEnv } from '@noisytransfer/test-helpers';

export async function startBroker() {
  // createTestEnv returns { api, relay, close }
  return await createTestEnv();
}

export async function stopBroker(env) {
  await env?.close?.();
}