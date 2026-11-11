#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  fetch: (input, init) => fetch(input, init),
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
