import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Compiled INTO this package (JavaScript and declarations), so the published package has no runtime dependencies:
//   - `@nanoflags/engine`, `@nanoflags/sdk` (core client + React bindings), `@nanoflags/openfeature-provider` — the
//     workspace sources, so the React Native SDK always ships exactly the engine/client the parity tests ran against;
//   - `@noble/ed25519` + `@noble/hashes` (MIT, pinned exact versions in package.json): a private copy, so configuring
//     its SHA-512 hook never touches an app's own copy, and no ESM-only package reaches Jest/CommonJS consumers.
// Peers stay external: react, react-native, the OpenFeature SDKs.
export default defineConfig({
  entry: { index: "src/index.ts", openfeature: "src/openfeature.ts", engine: "src/engine.ts" },
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2022",
  outDir: "dist",
  clean: true,
  tsconfig: "tsconfig.build.json",
  dts: true,
  alias: {
    "@nanoflags/engine": here("../engine/src/index.ts"),
    "@nanoflags/sdk/react": here("../sdk/src/react.ts"),
    "@nanoflags/sdk": here("../sdk/src/index.ts"),
    "@nanoflags/openfeature-provider/web": here("../openfeature/src/web.ts"),
    "@nanoflags/openfeature-provider": here("../openfeature/src/index.ts"),
  },
  deps: {
    alwaysBundle: ["@nanoflags/engine", "@nanoflags/sdk", "@nanoflags/openfeature-provider", /^@noble\//],
    neverBundle: ["react", "react-native", /^@openfeature\//],
    onlyImport: ["react", "react-native", "@openfeature/core", "@openfeature/web-sdk"],
  },
});
