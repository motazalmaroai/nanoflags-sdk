import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against the SDK sources, so they do not depend on a prior `pnpm --filter @nanoflags/sdk build`.
export default defineConfig({
  resolve: { alias: { "@nanoflags/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)) } },
});
