import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin.js", import.meta.url));
const manifest = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 30_000 });

test("runs the CLI and lists init", () => {
  const r = run("--help");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\binit\b/);
  assert.ok(r.stdout.includes(manifest("../../cli/package.json").version));
});

test("passes the CLI's exit code through", () => {
  const direct = spawnSync(process.execPath, [fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url)), "no-such-command"], { encoding: "utf8", timeout: 30_000 });
  const r = run("no-such-command");
  assert.notEqual(direct.status, 0);
  assert.equal(r.status, direct.status);
});

test("carries the same version as @nanoflags/cli", () => {
  assert.equal(manifest("../package.json").version, manifest("../../cli/package.json").version);
});
