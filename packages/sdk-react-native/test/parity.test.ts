/**
 * Cross-SDK parity through the BUILT React Native package (`dist/`, as published; `pnpm test` builds first).
 *
 * Fixtures: `packages/engine/fixtures/parity.json` (shared by every port, 21,998 evaluation cases + murmur3 / bucket /
 * supportsEngine / client-view vectors) and `packages/sdk-go/internal/testdata/extra.json` (JavaScript corner cases).
 *
 * Two paths:
 *   1. every case through `@nanoflags/react-native/engine` (the engine compiled into the package);
 *   2. every case whose bundle a client accepts (a valid bundle for a supported engine, or no bundle) through the React
 *      Native CLIENT: `createClient({ bootstrap })`, `identify(context)`, `evaluate(flag, fallback)`.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
if (!existsSync(dist)) throw new Error("dist/ is missing: run `pnpm build` first (`pnpm test` does).");
// Computed specifiers: typed by the sources (the API the build was made from), loaded from the build.
const distEntry = (name: string) => new URL(`../dist/${name}`, import.meta.url).href;
const rn = (await import(/* @vite-ignore */ distEntry("index.js"))) as typeof import("../src/index.js");
const engine = (await import(/* @vite-ignore */ distEntry("engine.js"))) as typeof import("../src/engine.js");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Case {
  name: string;
  bundle: number;
  flag: string;
  context: number;
  fallback: Json;
  expected: { value?: Json; reason: string; ruleIndex?: number; ruleId?: string; inRollout?: boolean; bucket?: number; revision: number; trace?: Array<{ kind: string; title: string; detail?: string; matched?: boolean }>; error?: boolean; errorMessage?: string };
}
interface Fixture {
  engineVersion?: number;
  counts?: Record<string, number>;
  murmur3?: Array<{ input: string; seed: number; hash: number }>;
  buckets?: Array<{ seed: string; identity: string; bucket: number }>;
  supportsEngine?: Array<{ bundle: unknown; expected: boolean }>;
  clientBundle?: Array<{ bundle: unknown; expected: unknown }>;
  bundles: unknown[];
  contexts: Array<Record<string, Json>>;
  cases: Case[];
}

const load = (rel: string): Fixture => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as Fixture;
const parity = load("../../engine/fixtures/parity.json");
// packages/sdk-go in the monorepo, go/ in the public repository.
const extraPath = ["../../sdk-go/internal/testdata/extra.json", "../../../go/internal/testdata/extra.json"].find((p) => existsSync(fileURLToPath(new URL(p, import.meta.url))));
const extra = extraPath ? load(extraPath) : null;

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

interface EvaluationLike {
  value?: unknown;
  reason: string;
  ruleIndex?: number;
  ruleId?: string;
  inRollout?: boolean;
  bucket?: number;
  revision: number;
  trace: Array<{ kind: string; title: string; detail?: string; matched?: boolean }>;
  error?: string;
}

/** Same comparison as the Python and Go ports (trace compared when recorded; error detail masked). */
function compare(e: EvaluationLike, x: Case["expected"], withErrorMessage: boolean): string[] {
  const problems: string[] = [];
  const check = (name: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${name}: rn=${JSON.stringify(a)} ts=${JSON.stringify(b)}`);
  };
  check("reason", e.reason, x.reason);
  check("value", e.value, x.value);
  check("revision", e.revision, x.revision);
  check("ruleIndex", e.ruleIndex, x.ruleIndex);
  check("ruleId", e.ruleIndex === undefined ? undefined : e.ruleId, x.ruleId);
  check("inRollout", e.inRollout, x.inRollout);
  check("bucket", e.bucket, x.bucket);
  check("error", e.error !== undefined, x.error ?? false);
  if (withErrorMessage && x.errorMessage !== undefined) check("errorMessage", e.error, x.errorMessage);
  if (x.trace) {
    let mine = clone(e.trace);
    let theirs = x.trace;
    if (x.error && mine.length > 0 && theirs.length > 0) {
      mine = [...mine.slice(0, -1), { ...mine.at(-1)!, detail: "<error>" }];
      theirs = [...theirs.slice(0, -1), { ...theirs.at(-1)!, detail: "<error>" }];
    }
    check("trace", mine, theirs);
  }
  return problems;
}

const isClientBundle = (b: unknown): boolean => {
  if (typeof b !== "object" || b === null) return false;
  const r = b as Record<string, unknown>;
  return r.schema === 1 && typeof r.revision === "number" && typeof r.flags === "object" && r.flags !== null && !Array.isArray(r.flags) && typeof r.segments === "object" && r.segments !== null && engine.supportsEngine(r as { engine?: unknown });
};

const clients: Array<{ close(): void }> = [];
afterAll(() => clients.splice(0).forEach((c) => c.close()));

/** One offline React Native client per bundle (bootstrap only: no storage, no network, no lifecycle, no telemetry). */
function clientFor(bundle: unknown) {
  const c = rn.createClient({
    sdkKey: "nf_pub_parity_test",
    baseUrl: "https://edge.invalid",
    ...(bundle === null ? {} : { bootstrap: clone(bundle) as never }),
    storage: false,
    appState: null,
    events: false,
    streaming: false,
    pollIntervalMs: 0,
    fetch: (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch,
  });
  clients.push(c);
  return c;
}

const summary: Record<string, number> = {};

function runAll(name: string, fx: Fixture, withErrorMessage: boolean) {
  describe(`${name} through @nanoflags/react-native (built)`, () => {
    it("every case through the bundled engine (`/engine` entry)", () => {
      const failures: Array<[string, string[]]> = [];
      for (const c of fx.cases) {
        const bundle = c.bundle === -1 ? null : clone(fx.bundles[c.bundle]);
        const e = engine.evaluate(bundle as never, c.flag, clone(fx.contexts[c.context]) as never, clone(c.fallback) as never) as EvaluationLike;
        const p = compare(e, c.expected, withErrorMessage);
        if (p.length > 0) failures.push([c.name, p]);
      }
      summary[`${name}: engine entry`] = fx.cases.length - failures.length;
      expect(failures.slice(0, 5)).toEqual([]);
    });

    it("every case with a client-acceptable bundle through the React Native client (identify + evaluate)", () => {
      const failures: Array<[string, string[]]> = [];
      const byBundle = new Map<number, ReturnType<typeof clientFor>>();
      let ran = 0;
      for (const c of fx.cases) {
        const raw = c.bundle === -1 ? null : fx.bundles[c.bundle];
        if (raw !== null && !isClientBundle(raw)) continue;
        let client = byBundle.get(c.bundle);
        if (!client) byBundle.set(c.bundle, (client = clientFor(raw)));
        client.identify(clone(fx.contexts[c.context]) as never);
        const e = client.evaluate(c.flag, clone(c.fallback) as never) as unknown as EvaluationLike;
        ran++;
        const p = compare(e, c.expected, withErrorMessage);
        if (p.length > 0) failures.push([c.name, p]);
      }
      summary[`${name}: client`] = ran - failures.length;
      summary[`${name}: client (of total)`] = fx.cases.length;
      expect(ran).toBeGreaterThan(0);
      expect(failures.slice(0, 5)).toEqual([]);
    });
  });
}

describe("parity.json vectors", () => {
  it("fixture matches the bundled engine version", () => {
    expect(parity.engineVersion).toBe(engine.ENGINE_VERSION);
    expect(parity.engineVersion).toBe(rn.SUPPORTED_ENGINE_VERSION);
    expect(parity.cases.length).toBe(parity.counts!.cases);
    expect(parity.cases.length).toBeGreaterThan(20_000);
  });

  it("murmur3, bucket and supportsEngine vectors", () => {
    expect(parity.murmur3!.filter((v) => engine.murmur3(v.input, v.seed) !== v.hash)).toEqual([]);
    expect(parity.buckets!.filter((v) => engine.bucketOf(v.seed, v.identity) !== v.bucket)).toEqual([]);
    expect(parity.supportsEngine!.filter((v) => engine.supportsEngine(clone(v.bundle) as never) !== v.expected)).toEqual([]);
    summary["vectors: murmur3"] = parity.murmur3!.length;
    summary["vectors: buckets"] = parity.buckets!.length;
    summary["vectors: supportsEngine"] = parity.supportsEngine!.length;
  });

  it("browser view (client bundle) vectors: the view client keys receive, and the client evaluating it", () => {
    for (const v of parity.clientBundle!) {
      const view = engine.clientBundle(clone(v.bundle) as never);
      expect(view).toEqual(v.expected);
      // The client given the full bundle's client view evaluates exactly like the engine does on that view.
      const client = clientFor(v.expected);
      for (const key of Object.keys((v.expected as { flags: Record<string, unknown> }).flags)) {
        expect(client.evaluate(key, null)).toEqual(engine.evaluate(clone(v.expected) as never, key, {}, null));
      }
    }
    summary["vectors: clientBundle"] = parity.clientBundle!.length;
  });
});

runAll("parity.json", parity, false);
if (extra) runAll("extra.json", extra, true);

afterAll(() => {
  // Printed so the numbers can be quoted (e.g. in the release notes).
  console.log("parity summary:", JSON.stringify(summary));
});
