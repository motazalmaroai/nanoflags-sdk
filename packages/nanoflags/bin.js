#!/usr/bin/env node
// The short name for @nanoflags/cli: runs that package's `nanoflags` command, unchanged.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifest = require.resolve("@nanoflags/cli/package.json");
const { bin } = require(manifest);
await import(pathToFileURL(join(dirname(manifest), bin.nanoflags)).href);
