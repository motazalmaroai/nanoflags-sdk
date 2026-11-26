#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { main } from "./main.js";

/** One line from the terminal. `secret` echoes nothing (the connection string holds a token). */
function prompt(question: string, o: { secret?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (o.secret) {
      process.stdout.write(question);
      // Suppress the echo of typed or pasted characters; keep the newline.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes("\n") || s.includes("\r")) process.stdout.write("\n");
      };
      rl.question("", (a) => {
        rl.close();
        resolve(a);
      });
    } else
      rl.question(question, (a) => {
        rl.close();
        resolve(a);
      });
  });
}

function open(url: string): void {
  const [cmd, args]: [string, string[]] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the URL is printed as well */
  }
}

function exec(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  fetch: (input, init) => fetch(input, init),
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  ...(interactive ? { prompt, open } : {}),
  exec,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
