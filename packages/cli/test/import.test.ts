import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiError, cli, json } from "./helpers";
import { parseContexts, parseEnvMap } from "../src/import";

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

describe("nanoflags import verify", () => {
  const exported = join(dir, "export.json");
  writeFileSync(exported, JSON.stringify({ environments: ["production"], gates: [{ id: "banner", isEnabled: true, rules: [{ id: "r1", passPercentage: 100, environments: null, conditions: [{ type: "country", operator: "any", targetValue: ["SA"] }] }] }] }));
  const jsonl = join(dir, "contexts.jsonl");
  writeFileSync(jsonl, '{"key":"a","country":"SA"}\n\n{"key":"b","country":"sa"}\n{"userID":"c"}\n');
  const comparison = (differs: number) => ({
    method: "gates-approximation",
    contexts: 3,
    flags: [{ flag: "banner", sourceKey: "banner", sourceEnvironment: "production", environment: "production", status: differs ? "differs" : "same", compared: 3, differs, splitDiffers: 0, sourceErrors: 0 }],
    differences: differs ? [{ index: 1, flag: "banner", sourceKey: "banner", sourceEnvironment: "production", environment: "production", kind: "rule", source: true, nanoflags: false, context: { key: "b", country: "sa" } }] : [],
    summary: { evaluations: 3, same: differs ? 0 : 1, differs: differs ? 1 : 0, splitOnly: 0, notCompared: 0, skipped: 0, differingContexts: differs, unchecked: 0 },
    caveats: ["Only the given contexts are compared."],
  });
  const answer = (differs: number) => json({ ...result(true), source: "gates-configs", envMap: { production: "production" }, comparison: comparison(differs) });

  it("sends a dry run with the contexts and lists the differing ones (exit 1)", async () => {
    const r = await cli(["import", "verify", exported, "--contexts", jsonl, "--project", "shop", "--flags", "banner"], { env: { NANOFLAGS_API_TOKEN: TOKEN }, routes: { "POST /api/v1/projects/shop/imports": answer(1) } });
    expect(r.code, r.err).toBe(1);
    const body = r.calls[0]!.body as { dryRun: boolean; contexts: unknown[]; compareFlags: string[]; format: string };
    // Nothing is written, so flags that already exist are compared too (overwrite unless --conflict says otherwise).
    expect(body).toMatchObject({ dryRun: true, format: "auto", compareFlags: ["banner"], conflict: "overwrite" });
    expect(body.contexts).toEqual([{ key: "a", country: "SA" }, { key: "b", country: "sa" }, { userID: "c" }]);
    expect(r.calls[0]!.headers.get("Idempotency-Key")).toBeNull();
    expect(r.out).toContain("Side-by-side comparison (dry run, nothing written) · source JSON export (re-implemented evaluation)");
    expect(r.out).toContain("#2 banner (production) [rule] source true → NanoFlags false");
    expect(r.out).not.toContain(TOKEN);
  });

  it("exit 0 when every context agrees; --json prints the comparison", async () => {
    const ok = await cli(["import", "verify", exported, "--contexts", jsonl, "--project", "shop"], { env: { NANOFLAGS_API_TOKEN: TOKEN }, routes: { "POST /api/v1/projects/shop/imports": answer(0) } });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain("Every compared context gets the same value");
    const j = await cli(["import", "verify", exported, "--contexts", jsonl, "--project", "shop", "--json"], { env: { NANOFLAGS_API_TOKEN: TOKEN }, routes: { "POST /api/v1/projects/shop/imports": answer(1) } });
    expect(JSON.parse(j.out).comparison.summary.differs).toBe(1);
  });

  it("exit 1 when pairs were left unchecked by the budget; --conflict is passed through", async () => {
    const c = comparison(0);
    const partial = json({ ...result(true), source: "gates-configs", envMap: { production: "production" }, comparison: { ...c, summary: { ...c.summary, unchecked: 3 } } });
    const r = await cli(["import", "verify", exported, "--contexts", jsonl, "--project", "shop", "--conflict", "skip"], { env: { NANOFLAGS_API_TOKEN: TOKEN }, routes: { "POST /api/v1/projects/shop/imports": partial } });
    expect(r.code, r.err).toBe(1);
    expect(r.out).toContain("Failed: 3 flag/environment pair(s) were not compared (evaluation budget)");
    expect((r.calls[0]!.body as { conflict: string }).conflict).toBe("skip");
  });

  it("refuses bad context files before calling the API", async () => {
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, '{"key":"a"}\nnope\n');
    const arr = join(dir, "arr.json");
    writeFileSync(arr, JSON.stringify([{ key: "a" }, [1]]));
    for (const args of [["--contexts", bad], ["--contexts", arr], ["--contexts", join(dir, "missing.jsonl")], []]) {
      const r = await cli(["import", "verify", exported, "--project", "shop", ...args], { env: { NANOFLAGS_API_TOKEN: TOKEN } });
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
    const r = await cli(["import", "verify", exported, "--project", "shop", "--contexts", bad], { env: { NANOFLAGS_API_TOKEN: TOKEN } });
    expect(r.err).toContain("bad.jsonl:2");
    expect(parseContexts('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(() => parseContexts(Array.from({ length: 1001 }, () => "{}").join("\n"))).toThrow(/at most 1000/);
  });
});
