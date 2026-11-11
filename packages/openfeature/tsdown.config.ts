import { defineConfig } from "tsdown";

// `@nanoflags/sdk` (types only) and the OpenFeature SDKs are peer dependencies: never bundled.
// tsconfig.json maps `@nanoflags/sdk` to the SDK's source for type checking, so building this package
// does not need a prior SDK build; the emitted `.d.ts` keeps importing `@nanoflags/sdk` by name.
export default defineConfig({
  entry: { index: "src/index.ts", server: "src/server.ts", web: "src/web.ts" },
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2022",
  outDir: "dist",
  clean: true,
  tsconfig: "tsconfig.build.json",
  dts: true,
  deps: {
    neverBundle: ["@nanoflags/sdk", /^@openfeature\//],
    onlyImport: ["@nanoflags/sdk", "@openfeature/core", "@openfeature/server-sdk", "@openfeature/web-sdk"],
  },
});
