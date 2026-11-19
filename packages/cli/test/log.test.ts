import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, clientView, signingTexts, verifyCosignature, type CosignPreview } from "../src/cosign";
import { headText, rootOf, verifyConsistency } from "../src/log";
import { ADMIN_KEY, SERVER_KEY, apiError, cli, json } from "./helpers";

const ENV_ID = "6f0c7c1e-0000-4000-8000-000000000001";
const H = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();

/** A reference log with RFC 9162 consistency proofs. */
class TestLog {
  texts: string[] = [];
  get leaves() {
    return this.texts.map((t) => H(Buffer.from([0]), Buffer.from(t, "utf8")));
  }
  add(revision: number, mode = "standard") {
    this.texts.push(["nanoflags-log-v1", ENV_ID, String(revision), `c${revision}`, "a".repeat(64), "b".repeat(64), String(1700000000000 + revision), mode === "emergency" ? "kill" : "publish", mode, mode === "cosigned" ? "ci-1" : "-"].join("\n"));
    return this;
  }
  private mth(l: Buffer[], a: number, b: number): Buffer {
    if (b - a === 1) return l[a]!;
    let k = 1;
    while (k * 2 < b - a) k *= 2;
    return H(Buffer.from([1]), this.mth(l, a, a + k), this.mth(l, a + k, b));
  }
  root(n = this.texts.length) {
    return this.mth(this.leaves, 0, n).toString("hex");
  }
  consistency(m: number, n: number): string[] {
    const l = this.leaves;
    const out: Buffer[] = [];
    const sub = (m: number, a: number, b: number, first: boolean) => {
      if (m === b - a) return void (first ? undefined : out.push(this.mth(l, a, b)));
      let k = 1;
      while (k * 2 < b - a) k *= 2;
      if (m <= k) {
        sub(m, a, a + k, first);
        out.push(this.mth(l, a + k, b));
      } else {
        sub(m - k, a + k, b, false);
        out.push(this.mth(l, a, a + k));
      }
    };
    if (m < n) sub(m, 0, n, true);
    return out.map((x) => x.toString("hex"));
  }
}

const nf = generateKeyPairSync("ed25519");
const nfPublic = { ...(nf.publicKey.export({ format: "jwk" }) as Record<string, string>), kid: "k1" };

function headOf(log: TestLog, size = log.texts.length) {
  const h = { size, root: log.root(size), timestamp: 1700000009000 + size, kid: "k1" };
  return { ...h, signature: sign(null, Buffer.from(headText(ENV_ID, h)), nf.privateKey).toString("base64url") };
}

function logRoutes(log: TestLog, head = headOf(log)) {
  return {
    "GET /v1/log/head": json({ environmentId: ENV_ID, head }),
    "GET /v1/log/entries": () => json({ environmentId: ENV_ID, size: log.texts.length, entries: log.texts.map((leaf, index) => ({ index, leaf })) }),
    "GET /v1/log/consistency": (c: { path: string }) => c && json({ proof: [] }),
  };
}

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), "nanoflags-log-"));
  writeFileSync(join(dir, "keys.json"), JSON.stringify({ keys: [nfPublic] }));
  return dir;
}

describe("log verify", () => {
  it("verifies the signed head, every entry and the root; reports co-signed and emergency revisions", async () => {
    const log = new TestLog().add(1).add(2, "cosigned").add(3, "emergency").add(5);
    const dir = workdir();
    const r = await cli(["log", "verify", "--public-keys", "keys.json", "--state", "state.json"], { routes: logRoutes(log), cwd: dir, env: { NANOFLAGS_SDK_KEY: SERVER_KEY } });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("head: 4 entries");
    expect(r.out).toContain("1 co-signed, 1 emergency");
    expect(r.out).toContain("emergency: r3");
    expect(r.out).toContain("not in the log: 1 revision(s)");
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).heads[ENV_ID].size).toBe(4);
  });

  it("fails when an entry was altered (the entries no longer hash to the signed root)", async () => {
    const log = new TestLog().add(1).add(2);
    const head = headOf(log);
    log.texts[0] = log.texts[0]!.replace("c1", "cX");
    const r = await cli(["log", "verify", "--public-keys", "keys.json"], { routes: logRoutes(log, head), cwd: workdir() });
    expect(r.code).toBe(1);
    expect(r.out).toContain("do not hash to the signed root");
  });

  it("fails when the head is not signed by NanoFlags", async () => {
    const log = new TestLog().add(1);
    const head = { ...headOf(log), signature: sign(null, Buffer.from("x"), generateKeyPairSync("ed25519").privateKey).toString("base64url") };
    const r = await cli(["log", "verify", "--public-keys", "keys.json"], { routes: logRoutes(log, head), cwd: workdir() });
    expect(r.code).toBe(1);
    expect(r.out).toContain("not signed by a NanoFlags key");
  });

  it("with --state: a grown log must extend the saved head; a rewritten history fails", async () => {
    const dir = workdir();
    const log = new TestLog().add(1).add(2).add(3);
    expect((await cli(["log", "verify", "--public-keys", "keys.json", "--state", "s.json"], { routes: logRoutes(log), cwd: dir })).code).toBe(0);
    log.add(4).add(5);
    const grown = { ...logRoutes(log), "GET /v1/log/consistency": json({ proof: log.consistency(3, 5) }) };
    const ok = await cli(["log", "verify", "--public-keys", "keys.json", "--state", "s.json"], { routes: grown, cwd: dir });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("extends the head saved");

    const fork = new TestLog().add(1).add(9).add(3).add(4).add(5).add(6);
    const forked = { ...logRoutes(fork), "GET /v1/log/consistency": json({ proof: fork.consistency(5, 6) }) };
    const bad = await cli(["log", "verify", "--public-keys", "keys.json", "--state", "s.json"], { routes: forked, cwd: dir });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("rewritten or forked");
  });

  it("refuses a key of another environment when --env is given", async () => {
    const r = await cli(["log", "verify", "--env", "00000000-0000-4000-8000-000000000000", "--public-keys", "keys.json"], { routes: logRoutes(new TestLog().add(1)), cwd: workdir() });
    expect(r.code).toBe(2);
  });
});

describe("log monitor", () => {
  it("saves a baseline, then checks each new head for consistency (CI one-shot)", async () => {
    const dir = workdir();
    const log = new TestLog().add(1).add(2);
    const first = await cli(["log", "monitor", "--state", "m.json", "--public-keys", "keys.json"], { routes: logRoutes(log), cwd: dir });
    expect(first.code).toBe(0);
    expect(first.out).toContain("saved as the first baseline");
    log.add(3);
    const second = await cli(["log", "monitor", "--state", "m.json", "--public-keys", "keys.json"], { routes: { ...logRoutes(log), "GET /v1/log/consistency": json({ proof: log.consistency(2, 3) }) }, cwd: dir });
    expect(second.code).toBe(0);
    const shrunk = await cli(["log", "monitor", "--state", "m.json", "--public-keys", "keys.json"], { routes: logRoutes(new TestLog().add(1)), cwd: dir });
    expect(shrunk.code).toBe(1);
    expect(shrunk.out).toContain("the log shrank");
    expect((await cli(["log", "monitor"], { routes: logRoutes(log) })).code).toBe(2);
  });

  it("the verifier helpers agree with the reference tree", () => {
    const log = new TestLog();
    for (let i = 1; i <= 9; i++) log.add(i);
    for (let n = 1; n <= 9; n++) {
      expect(rootOf(log.leaves.slice(0, n))).toBe(log.root(n));
      for (let m = 1; m <= n; m++) expect(verifyConsistency(m, n, log.root(m), log.root(n), log.consistency(m, n))).toBe(true);
    }
    expect(rootOf([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("co-signing: keygen, sign, publish --cosign", () => {
  const bundle = {
    flags: { a: { type: "boolean", enabled: true, rules: [{ id: "r", match: "all", conditions: [{ attribute: "", op: "segment", value: "beta" }], serve: { type: "fixed", value: true } }], default: false, off: false, clientExposed: true }, s: { type: "string", enabled: true, rules: [], default: "é", off: "", clientExposed: false } },
    segments: { beta: { match: "all", conditions: [] }, staff: { match: "all", conditions: [] } },
    schema: 1, project: "shop", environment: "prod", revision: 8,
  };

  it("keygen writes a private JWK (mode 600) and prints the public key", async () => {
    const dir = workdir();
    const r = await cli(["keygen", "--out", "ci.jwk", "--kid", "ci-1"], { cwd: dir });
    expect(r.code).toBe(0);
    const pub = JSON.parse(r.out) as { x: string; kid: string; d?: string };
    expect(pub.kid).toBe("ci-1");
    expect(pub.d).toBeUndefined();
    expect(statSync(join(dir, "ci.jwk")).mode & 0o777).toBe(0o600);
    expect((await cli(["keygen", "--out", "ci.jwk"], { cwd: dir })).code).toBe(2); // never overwrites
  });

  it("sign computes the bundle texts locally, signs both views with the registered key, and publish sends it", async () => {
    const dir = workdir();
    const gen = await cli(["keygen", "--out", "ci.jwk", "--kid", "ci-1"], { cwd: dir });
    const pub = JSON.parse(gen.out) as { x: string };
    const preview: CosignPreview = { environmentId: ENV_ID, expectedRevision: 7, revision: 8, checksum: "c8", bundle, required: true, keys: [{ kid: "ci-1", publicKey: pub.x }] };
    const r = await cli(["sign", "--key", "ci.jwk", "--out", "cosign.json", "--bundle-out", "bundle.json"], { cwd: dir, routes: { "GET /v1/admin/cosign/preview": json(preview) } });
    expect(r.code).toBe(0);
    expect(r.err).toContain("Signed r8");
    const cs = JSON.parse(readFileSync(join(dir, "cosign.json"), "utf8"));
    expect(verifyCosignature(preview, cs, pub.x)).toBe(true);
    // The exact text the publisher will sign: engine added at the end, browser view without the server-only flag/segment.
    const texts = signingTexts(bundle);
    expect(readFileSync(join(dir, "bundle.json"), "utf8")).toBe(texts.server);
    expect(JSON.parse(texts.server).engine).toBe(1);
    expect(Object.keys(JSON.parse(texts.client).flags)).toEqual(["a"]);
    expect(Object.keys(JSON.parse(texts.client).segments)).toEqual(["beta"]);
    expect(canonical(ENV_ID, 8, "c8", texts.server)).toBe(`nanoflags-bundle-v1\n${ENV_ID}\n8\nc8\n${createHash("sha256").update(texts.server).digest("hex")}`);

    const pubd = await cli(["publish", "--expected-revision", "7", "--cosign", "cosign.json"], { cwd: dir, routes: { "POST /v1/admin/publish": json({ revision: 8, checksum: "c8" }) } });
    expect(pubd.code).toBe(0);
    expect(pubd.calls.at(-1)!.body).toMatchObject({ expectedRevision: 7, cosignature: { kid: "ci-1", revision: 8, checksum: "c8", server: cs.server, client: cs.client } });
    expect((await cli(["publish", "--expected-revision", "6", "--cosign", "cosign.json"], { cwd: dir })).code).toBe(2);
    expect(pubd.calls.at(-1)!.body).not.toHaveProperty("change");

    // --change publishes through an approved change (needs --cosign and a UUID).
    const change = "0b6f0c4e-9a43-4a0e-8f43-3f0d3c1b2a10";
    const viaChange = await cli(["publish", "--expected-revision", "7", "--cosign", "cosign.json", "--change", change], { cwd: dir, routes: { "POST /v1/admin/publish": json({ revision: 8, checksum: "c8" }) } });
    expect(viaChange.code).toBe(0);
    expect(viaChange.out).toContain(`through change ${change}`);
    expect(viaChange.calls.at(-1)!.body).toMatchObject({ expectedRevision: 7, change, cosignature: { kid: "ci-1", revision: 8 } });
    expect(await cli(["publish", "--expected-revision", "7", "--change", change], { cwd: dir })).toMatchObject({ code: 2, calls: [] });
    expect(await cli(["publish", "--expected-revision", "7", "--cosign", "cosign.json", "--change", "nope"], { cwd: dir })).toMatchObject({ code: 2, calls: [] });
    const refused = await cli(["publish", "--expected-revision", "7", "--cosign", "cosign.json", "--change", change], { cwd: dir, routes: {
      "POST /v1/admin/publish": apiError(422, "APPROVAL_REQUIRED", "An independent approval of the current draft is required.") } });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("[APPROVAL_REQUIRED]");
  });

  it("sign --expect / --expect-checksum refuses a draft other than the one CI expects, with a per-flag diff", async () => {
    const dir = workdir();
    const gen = await cli(["keygen", "--out", "ci.jwk", "--kid", "ci-1"], { cwd: dir });
    const pub = JSON.parse(gen.out) as { x: string };
    const preview: CosignPreview = { environmentId: ENV_ID, expectedRevision: 7, revision: 8, checksum: "c8", bundle, required: true, keys: [{ kid: "ci-1", publicKey: pub.x }] };
    const routes = { "GET /v1/admin/cosign/preview": json(preview) };
    // Same content, other key order and with `engine`: accepted.
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ segments: { staff: bundle.segments.staff, beta: bundle.segments.beta }, flags: { s: bundle.flags.s, a: bundle.flags.a }, engine: 1 }));
    const good = await cli(["sign", "--key", "ci.jwk", "--expect", "ok.json", "--expect-checksum", "c8", "--out", "cosign.json"], { cwd: dir, routes });
    expect(good.code).toBe(0);
    expect(existsSync(join(dir, "cosign.json"))).toBe(true);
    // A compromised edge serves another draft: refused, nothing written.
    writeFileSync(join(dir, "want.json"), JSON.stringify({ flags: { a: { ...bundle.flags.a, default: true }, gone: bundle.flags.s }, segments: bundle.segments }));
    const bad = await cli(["sign", "--key", "ci.jwk", "--expect", "want.json", "--out", "bad.json"], { cwd: dir, routes });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Refusing to sign");
    expect(bad.err).toContain("~ flag a:");
    expect(bad.err).toContain("- flag gone: expected, missing from the draft");
    expect(bad.err).toContain("+ flag s: in the draft, not expected");
    expect(existsSync(join(dir, "bad.json"))).toBe(false);
    const sum = await cli(["sign", "--key", "ci.jwk", "--expect-checksum", "c7", "--out", "bad.json"], { cwd: dir, routes });
    expect(sum.code).toBe(1);
    expect(sum.err).toContain("--expect-checksum is c7");
    expect(existsSync(join(dir, "bad.json"))).toBe(false);
  });

  it("sign refuses a key that is not the one registered under its id", async () => {
    const dir = workdir();
    await cli(["keygen", "--out", "ci.jwk", "--kid", "ci-1"], { cwd: dir });
    const other = (generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;
    const preview = { environmentId: ENV_ID, expectedRevision: 7, revision: 8, checksum: "c8", bundle, required: true, keys: [{ kid: "ci-1", publicKey: other }] };
    const r = await cli(["sign", "--key", "ci.jwk"], { cwd: dir, routes: { "GET /v1/admin/cosign/preview": json(preview) } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not the key registered");
    expect((await cli(["sign"], { cwd: dir })).code).toBe(2);
    expect((await cli(["sign", "--key", "ci.jwk"], { cwd: dir, env: { NANOFLAGS_KEY: undefined } })).code).toBe(2);
    void ADMIN_KEY;
  });

  // In the NanoFlags monorepo the publisher's own code is next door: the texts must be byte-identical (skipped elsewhere).
  const shared = join(__dirname, "../../../workers/shared/src/bundle.ts");
  it.skipIf(!existsSync(shared))("signingTexts is byte-identical to what the publisher signs", async () => {
    const mod = (await import(/* @vite-ignore */ shared)) as { clientView: (b: Record<string, unknown>) => Record<string, unknown>; withEngine: (b: Record<string, unknown>) => Record<string, unknown> };
    for (const b of [bundle, { ...bundle, engine: 1 }, { flags: {}, segments: {} }, { flags: { z: { clientExposed: true, rules: [{ conditions: [{ op: "segment", value: "nope" }] }] } } }]) {
      const full = mod.withEngine(b as Record<string, unknown>);
      expect(signingTexts(b as Record<string, unknown>)).toEqual({ server: JSON.stringify(full), client: JSON.stringify(mod.clientView(full)) });
    }
  });

  it("clientView keeps segments transitively and in order", () => {
    const b = { flags: { x: { clientExposed: true, rules: [{ conditions: [{ op: "segment", value: "s2" }] }] } }, segments: { s1: {}, s2: { conditions: [{ op: "not_segment", value: "s3" }] }, s3: {} } };
    expect(Object.keys(clientView(b).segments as object)).toEqual(["s2", "s3"]);
  });
});
