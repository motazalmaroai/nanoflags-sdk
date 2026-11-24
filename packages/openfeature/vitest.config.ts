import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The same tests run three times:
//   - "sdk source": against the SDK sources of this repository, so they do not depend on a prior
//     `pnpm --filter @nanoflags/sdk build`;
//   - "sdk@0.8.0" and "sdk@0.8.1": against those published npm releases (devDependencies `sdk-<version>`, npm aliases
//     of @nanoflags/sdk): the oldest and the newest version of the peer range `^0.8.0`. Widen the range only together
//     with a project for the version it adds.
const sdkSource = fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url));
const sourceVersion = (JSON.parse(readFileSync(new URL("../sdk/package.json", import.meta.url), "utf8")) as { version: string }).version;
// EXPECTED_SDK_VERSION lets test/sdk-version.test.ts check that the alias really selected that SDK.
const against = (name: string, sdk: string, version: string) => ({
  extends: true as const,
  test: { name, env: { EXPECTED_SDK_VERSION: version } },
  resolve: { alias: { "@nanoflags/sdk": sdk } },
});

export default defineConfig({
  test: {
    projects: [against("sdk source", sdkSource, sourceVersion), against("sdk@0.8.0", "sdk-0.8.0", "0.8.0"), against("sdk@0.8.1", "sdk-0.8.1", "0.8.1")],
  },
});
