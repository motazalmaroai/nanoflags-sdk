import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiError, cli, json } from "./helpers";
import { parseEnvMap } from "../src/import";

const TOKEN = `nf_api_${"0".repeat(48)}`;
const dir = mkdtempSync(join(tmpdir(), "nanoflags-import-"));
const flagd = join(dir, "flags.flagd.json");
writeFileSync(flagd, JSON.stringify({ flags: { banner: { state: "ENABLED", variants: { on: true, off: false }, defaultVariant: "off" } } }));
const csv = join(dir, "flags.csv");
writeFileSync(csv, "key,type\nbanner,boolean\n");

const result = (dryRun: boolean) => ({
  dryRun,
  source: "flagd",
  sourceEnvironments: ["default"],
  envMap: { default: "development" },
  counts: { flags: { create: 1, overwrite: 0, skip: 0 }, segments: { create: 0, overwrite: 0, skip: 0 } },
  items: [{ kind: "flag", key: "banner", sourceKey: "banner", action: "create" }],
  conflicts: [],
  warnings: [{ severity: "warning", code: "FRACTIONAL_BUCKETING", message: "Percentage split…", flag: "banner" }],
  invalid: [],
  fidelity: { method: "flagd-reference-approximation", summary: { equivalent: 1, distribution: 0, mismatch: 0, not_proven: 0, skipped: 0 }, caveats: ["Agreement is shown on generated contexts."], flags: [{ flag: "banner", environment: "development", status: "equivalent", contexts: 2, matched: 2 }] },
  import: dryRun ? null : { id: "542e9698-9947-42d8-8a1e-ee55f94c92f0", status: "completed", created: 1, overwritten: 0, skipped: 0, failed: 0 },
  failures: [],
});

describe("nanoflags import", () => {
  it("parses --env-map", () => {
    expect(parseEnvMap("default=development, prod=production,old=")).toEqual({ default: "development", prod: "production", old: null });
    expect(() => parseEnvMap("nonsense")).toThrow(/env-map/);
  });

  it("dry run posts the file to the Management API and prints the preview", async () => {
    const r = await cli(["import", flagd, "--project", "shop", "--env-map", "default=development", "--dry-run"], { env: { NANOFLAGS_API_TOKEN: TOKEN }, routes: { "POST /api/v1/projects/shop/imports": json(result(true)) } });
    expect(r.code, r.err).toBe(0);
    const call = r.calls[0]!;
    expect(call.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.get("Idempotency-Key")).toBeNull();
    expect(call.body).toMatchObject({ format: "auto", dryRun: true, envMap: { default: "development" } });
    expect(typeof (call.body as { content: unknown }).content).toBe("string");
    expect(r.out).toContain("Dry run (nothing written)");
    expect(r.out).toContain("Fidelity (flagd-reference-approximation): 1 equivalent");
    expect(r.out).not.toContain(TOKEN);
  });

  it("apply sends an idempotency key and reports the import", async () => {
    const r = await cli(["import", csv, "--project", "shop", "--conflict", "rename"], { env: { NANOFLAGS_API_TOKEN: TOKEN }, routes: { "POST /api/v1/projects/shop/imports": json(result(false)) } });
    expect(r.code, r.err).toBe(0);
    expect(r.calls[0]!.body).toMatchObject({ format: "csv", conflict: "rename", dryRun: false });
    expect(r.calls[0]!.headers.get("Idempotency-Key")).toMatch(/^cli-import-[0-9a-f]{40}$/);
    expect(r.out).toContain("Imported into drafts (nothing published)");
    expect(r.out).toContain("1 created");
  });

  it("refuses without an API token or project, and maps API errors", async () => {
    expect((await cli(["import", flagd, "--project", "shop"])).code).toBe(2);
    expect((await cli(["import", flagd], { env: { NANOFLAGS_API_TOKEN: TOKEN } })).code).toBe(2);
    expect((await cli(["import", flagd, "--project", "shop", "--conflict", "merge"], { env: { NANOFLAGS_API_TOKEN: TOKEN } })).code).toBe(2);
    const scope = await cli(["import", flagd, "--project", "shop"], { env: { NANOFLAGS_API_TOKEN: TOKEN }, routes: { "POST /api/v1/projects/shop/imports": apiError(403, "INSUFFICIENT_SCOPE", "This API token does not have the flags:write scope.") } });
    expect(scope.code).toBe(2);
    expect(scope.err).toContain("INSUFFICIENT_SCOPE");
    const invalid = await cli(["import", flagd, "--project", "shop"], { env: { NANOFLAGS_API_TOKEN: TOKEN }, routes: { "POST /api/v1/projects/shop/imports": apiError(422, "INVALID", "The file is not valid JSON.") } });
    expect(invalid.code).toBe(1);
  });
});
