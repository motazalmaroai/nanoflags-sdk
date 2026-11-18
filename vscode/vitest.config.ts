import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The real `vscode` module only exists inside the editor; unit tests use a small in-memory stand-in.
    alias: { vscode: fileURLToPath(new URL("./test/vscode-mock.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
