import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function confirmPrompt(message) {
  const rl = readline.createInterface({ input, output });
  const ans = (await rl.question(`${message} [y/N] `)).trim();
  rl.close();
  return /^y(es)?$/i.test(ans);
}
