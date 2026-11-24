import { expect, it } from "vitest";
import { SDK_VERSION } from "@nanoflags/sdk";

declare const process: { env: Record<string, string | undefined> }; // (no @types/node in this package)

it("runs against the @nanoflags/sdk version its vitest project names", () => {
  expect(process.env.EXPECTED_SDK_VERSION).toBeTruthy();
  expect(SDK_VERSION).toBe(process.env.EXPECTED_SDK_VERSION);
});
