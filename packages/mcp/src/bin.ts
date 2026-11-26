#!/usr/bin/env node
import { ApiClient } from "./api.js";
import { VERSION, configFromEnv, createServer, serveStdio } from "./server.js";

const log = (line: string) => void process.stderr.write(`[nanoflags-mcp] ${line}\n`);

let config;
try {
  config = configFromEnv(process.env);
} catch (e) {
  log(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

const api = new ApiClient({ baseUrl: config.baseUrl, token: config.token, fetch: (input, init) => fetch(input, init), userAgent: `nanoflags-mcp/${VERSION}` });
const server = createServer({ api, defaultProject: config.project, log, transport: "stdio" });
log(`ready (${config.baseUrl}${config.project ? `, project ${config.project}` : ""})`);
serveStdio(server, { input: process.stdin, output: process.stdout }).then(() => process.exit(0));
