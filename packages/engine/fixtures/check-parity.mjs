// Runs `generate-parity.mjs --check` when this Node can load TypeScript sources directly (type stripping,
// Node >= 22.18 / 23.6); older Node versions skip the check with a notice (CI on Node 22+ still enforces it).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features?.typescript) {
  console.log(`parity fixture check skipped: Node ${process.version} cannot load .ts directly (needs >= 22.18).`);
  process.exit(0);
}
const script = join(dirname(fileURLToPath(import.meta.url)), "generate-parity.mjs");
const r = spawnSync(process.execPath, [script, "--check"], { stdio: "inherit" });
process.exit(r.status ?? 1);
