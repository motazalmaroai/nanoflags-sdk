import { defineConfig } from "tsdown";

// `@nanoflags/engine` is a private workspace package (TypeScript source only). It is compiled INTO this
// package — JavaScript and declarations — so the published SDK has no runtime dependency on it and its
// public types (`Bundle`, `Context`, `Evaluation`, `JsonValue`, `Reason`) live in the SDK's own `.d.ts`.
// `react` (optional peer, only `./react`) and `node:async_hooks` (only `./node`) stay external.
export default defineConfig({
  entry: { index: "src/index.ts", react: "src/react.ts", node: "src/node.ts" },
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2022",
  outDir: "dist",
  clean: true,
  tsconfig: "tsconfig.build.json",
  dts: true,
  // tsconfig.build.json maps `@nanoflags/engine` to its source (the declaration emitter needs the file in the program).
  // `onlyImport` fails the build if the output imports anything else (e.g. the engine by name).
  deps: { alwaysBundle: ["@nanoflags/engine"], neverBundle: ["react", /^node:/], onlyImport: ["react", "node:async_hooks"] },
});
