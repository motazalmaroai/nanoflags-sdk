import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Unit tests run against the workspace sources (no prior build of @nanoflags/sdk or the OpenFeature provider needed).
// `react-native` cannot run in Node (Flow sources, native modules): it is replaced by a small, scriptable shim with the
// same surface the SDK uses (`AppState`). The parity suite imports the built package (`dist/`), see test/parity.test.ts.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: here("./test/react-native-shim.ts") },
      { find: /^@nanoflags\/sdk\/react$/, replacement: here("../sdk/src/react.ts") },
      { find: /^@nanoflags\/sdk$/, replacement: here("../sdk/src/index.ts") },
      { find: /^@nanoflags\/openfeature-provider\/web$/, replacement: here("../openfeature/src/web.ts") },
      { find: /^@nanoflags\/openfeature-provider$/, replacement: here("../openfeature/src/index.ts") },
    ],
  },
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 20_000 },
});
