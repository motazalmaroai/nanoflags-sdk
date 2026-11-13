// `pnpm test` builds dist/ first, because the parity suite runs through the built package.
// The build tools (tsdown) need Node >= 22.18. On older Node versions (the public repository's CI also tests on
// Node 20, after building on Node 22) the existing dist/ is used as is; without one the tests cannot run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
const canBuild = major > 22 || (major === 22 && minor >= 18);
if (canBuild) {
  const r = spawnSync("tsdown", ["--log-level", "warn"], { stdio: "inherit", shell: process.platform === "win32" });
  process.exit(r.status ?? 1);
}
if (existsSync(fileURLToPath(new URL("../dist/index.js", import.meta.url)))) {
  console.log(`Node ${process.versions.node} cannot run the build tools: testing the existing dist/.`);
  process.exit(0);
}
console.error(`Node ${process.versions.node} cannot run the build tools (Node >= 22.18) and dist/ is missing: run \`pnpm build\` on Node 22 first.`);
process.exit(1);
