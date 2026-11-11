import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  // Keep `node:` specifiers as written (Node ≥ 20). The shebang in src/bin.ts is preserved and dist/bin.js is made executable.
  removeNodeProtocol: false,
  // The engine is a private workspace package: it is compiled into the CLI. `typescript` stays a dependency.
  noExternal: ["@nanoflags/engine"],
  external: ["typescript"],
});
