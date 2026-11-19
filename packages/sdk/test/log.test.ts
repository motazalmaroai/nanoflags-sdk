import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type Bundle, type NanoFlagsClient, type NanoFlagsError } from "../src/index";
import { headText, leafHash, onlyTurnsFlagsOff, verifyConsistency, verifyInclusion, type LogEvidence } from "../src/log";
import { canonicalString, sha256Hex } from "../src/verify";
import { BASE, SERVER_KEY, makeBundle } from "./helpers";
import { ENV_ID, makeSigner, mockRoutes, type Signer } from "./v2helpers";

/* ---------------- a small reference log (RFC 9162 proofs), independent of the SDK's verifiers ---------------- */

const H = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
class TestLog {
  leaves: Buffer[] = [];
  texts: string[] = [];
  append(text: string): number {
    this.texts.push(text);
    this.leaves.push(H(Buffer.from([0]), Buffer.from(text, "utf8")));
    return this.leaves.length - 1;
  }
  private mth(a: number, b: number): Buffer {
    if (b - a === 1) return this.leaves[a]!;
    let k = 1;
    while (k * 2 < b - a) k *= 2;
    return H(Buffer.from([1]), this.mth(a, a + k), this.mth(a + k, b));
  }
  root(n = this.leaves.length) {
    return this.mth(0, n).toString("hex");
  }
  inclusion(m: number, n = this.leaves.length): string[] {
    const out: Buffer[] = [];
    const path = (m: number, a: number, b: number) => {
      if (b - a <= 1) return;
      let k = 1;
      while (k * 2 < b - a) k *= 2;
      if (m < k) {
        path(m, a, a + k);
        out.push(this.mth(a + k, b));
      } else {
        path(m - k, a + k, b);
        out.push(this.mth(a, a + k));
      }
    };
    path(m, 0, n);
    return out.map((x) => x.toString("hex"));
  }
  consistency(m: number, n: number): string[] {
    const out: Buffer[] = [];
    const sub = (m: number, a: number, b: number, first: boolean) => {
      if (m === b - a) {
        if (!first) out.push(this.mth(a, b));
        return;
      }
      let k = 1;
      while (k * 2 < b - a) k *= 2;
      if (m <= k) {
        sub(m, a, a + k, first);
        out.push(this.mth(a + k, b));
      } else {
        sub(m - k, a + k, b, false);
        out.push(this.mth(a, a + k));
      }
    };
    if (m < n) sub(m, 0, n, true);
    return out.map((x) => x.toString("hex"));
  }
}

const leafFor = (revision: number, checksum: string, bundleSha: string, clientSha: string, mode = "standard", kid = "-") =>
  ["nanoflags-log-v1", ENV_ID, String(revision), checksum, bundleSha, clientSha, String(1700000000000 + revision), mode === "emergency" ? "kill" : "publish", mode, kid].join("\n");

let nf: Signer; // NanoFlags' bundle and tree-head key
let rogue: Signer;
let customer: Signer;
beforeAll(async () => {
  nf = await makeSigner("k1");
  rogue = await makeSigner("k1");
  customer = await makeSigner("ci-1");
});

const clients: NanoFlagsClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.restoreAllMocks();
});
function client(fetch: typeof globalThis.fetch, opts: Partial<Parameters<typeof createClient>[0]> = {}) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, streaming: false, pollIntervalMs: 0, events: false, verify: { publicKeys: [nf.publicJwk] }, fetch, ...opts });
  clients.push(c);
  const errors: NanoFlagsError[] = [];
  c.on("error", (e) => errors.push(e as NanoFlagsError));
  return { c, errors };
}

async function head(log: TestLog, signer = nf, size = log.leaves.length) {
  const h = { size, root: log.root(size), timestamp: 1700000001000 + size, kid: "k1" };
  return { ...h, signature: await signer.sign(headText(ENV_ID, h)) };
}

interface Published {
  bundle: Bundle;
  text: string;
  checksum: string;
  evidence: LogEvidence;
}
/** Publishes a revision into `log` (as the publisher would) and returns what the edge serves. */
async function publish(log: TestLog, bundle: Bundle, opts: { mode?: string; kid?: string; loggedText?: string } = {}): Promise<Published> {
  const text = JSON.stringify(bundle);
  const checksum = `c${bundle.revision}`;
  const sha = await sha256Hex(opts.loggedText ?? text);
  const index = log.append(leafFor(bundle.revision, checksum, sha, sha, opts.mode, opts.kid));
  return { bundle, text, checksum, evidence: { index, leaf: log.texts[index]!, proof: log.inclusion(index), head: await head(log) } };
}

async function response(p: Published, opts: { evidence?: boolean; cosign?: Signer | null; signTampered?: string } = {}): Promise<Response> {
  const text = opts.signTampered ?? p.text;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ETag: `"${p.checksum}-server"`,
    "X-NanoFlags-Environment-Id": ENV_ID,
    "X-NanoFlags-Signed": "true",
    "X-NanoFlags-Key-Id": "k1",
    "X-NanoFlags-Signature": await nf.sign(canonicalString(ENV_ID, p.bundle.revision, p.checksum, await sha256Hex(text))),
  };
  if (opts.evidence !== false) headers["X-NanoFlags-Log"] = Buffer.from(JSON.stringify(p.evidence)).toString("base64url");
  if (opts.cosign) {
    headers["X-NanoFlags-Cosignature"] = await opts.cosign.sign(canonicalString(ENV_ID, p.bundle.revision, p.checksum, await sha256Hex(text)));
    headers["X-NanoFlags-Cosigner-Key-Id"] = opts.cosign.kid;
  }
  return new Response(`{"revision":${p.bundle.revision},"checksum":"${p.checksum}","bundle":${text}}`, { status: 200, headers });
}

/* ---------------- vectors ---------------- */

describe("transparency-log verifiers (RFC 9162 vectors)", () => {
  const ROOT8 = "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328";
  it("inclusion: published audit paths for leaves 0 and 5 of the 8-leaf reference tree", async () => {
    const path0 = ["96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7", "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4"];
    const path5 = ["bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b", "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0", "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7"];
    expect(await leafHash("")).toBe("6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d");
    expect(await verifyInclusion(0, 8, await leafHash(""), path0, ROOT8)).toBe(true);
    expect(await verifyInclusion(5, 8, await leafHash("@ABC"), path5, ROOT8)).toBe(true);
    expect(await verifyInclusion(4, 8, await leafHash("@ABC"), path5, ROOT8)).toBe(false);
    expect(await verifyInclusion(5, 8, await leafHash("@ABD"), path5, ROOT8)).toBe(false);
  });
  it("consistency: published proofs (1→8, 6→8, 2→5); a forked first tree fails", async () => {
    const R1 = "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d";
    const R6 = "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef";
    const R2 = "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125";
    const R5 = "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4";
    const p18 = ["96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7", "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4"];
    const p68 = ["0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a", "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0", "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7"];
    const p25 = ["5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b"];
    expect(await verifyConsistency(1, 8, R1, ROOT8, p18)).toBe(true);
    expect(await verifyConsistency(6, 8, R6, ROOT8, p68)).toBe(true);
    expect(await verifyConsistency(2, 5, R2, R5, p25)).toBe(true);
    expect(await verifyConsistency(6, 8, R5, ROOT8, p68)).toBe(false);
    expect(await verifyConsistency(2, 5, R2, ROOT8, p25)).toBe(false);
    expect(await verifyConsistency(8, 8, ROOT8, ROOT8, [])).toBe(true);
  });
  it("the SDK's verifiers accept every proof of the reference log up to 9 leaves", async () => {
    const log = new TestLog();
    for (let i = 0; i < 9; i++) log.append(`leaf ${i}`);
    for (let n = 1; n <= 9; n++) {
      for (let m = 0; m < n; m++) expect(await verifyInclusion(m, n, log.leaves[m]!.toString("hex"), log.inclusion(m, n), log.root(n))).toBe(true);
      for (let m = 1; m <= n; m++) expect(await verifyConsistency(m, n, log.root(m), log.root(n), log.consistency(m, n))).toBe(true);
    }
  });
});

/* ---------------- client: verifyLog ---------------- */

describe("verifyLog", () => {
  it("a bundle recorded in the log, under a signed head, is adopted", async () => {
    const log = new TestLog();
    const p = await publish(log, makeBundle(1));
    const edge = mockRoutes({ "/v1/bundle": await response(p) });
    const { c, errors } = client(edge.fetch, { verifyLog: true });
    await c.ready();
    expect(c.revision).toBe(1);
    expect(errors).toEqual([]);
    expect(edge.count("/v1/log/proof")).toBe(0);
  });

  it("a tampered bundle — validly signed by a compromised signer, but not the bytes in the log — is rejected", async () => {
    const log = new TestLog();
    const good = await publish(log, makeBundle(1));
    const edge = mockRoutes({ "/v1/bundle": await response(good) });
    const { c, errors } = client(edge.fetch, { verifyLog: true });
    await c.ready();
    const evil = makeBundle(2, { "search-ranking": { type: "string", enabled: true, default: "attacker", off: "off", rules: [] } });
    // The log records the honest r2; the edge serves other bytes, signed with the real key.
    const honest = await publish(log, makeBundle(2));
    const tampered = { ...honest, bundle: evil, text: JSON.stringify(evil) };
    edge.routes["/v1/bundle"] = await response(tampered);
    edge.routes["/v1/log/consistency"] = new Response(JSON.stringify({ proof: log.consistency(1, 2) }));
    await c.refresh();
    expect(c.revision).toBe(1);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v1");
    expect(errors.at(-1)?.code).toBe("log");
    expect(errors.at(-1)?.message).toContain("differ from the ones recorded in the log");
  });

  it("no evidence on the bundle: the proof is fetched; a revision missing from the log is not applied", async () => {
    const log = new TestLog();
    const p1 = await publish(log, makeBundle(1));
    const edge = mockRoutes({ "/v1/bundle": await response(p1, { evidence: false }), "/v1/log/proof": new Response(JSON.stringify(p1.evidence)) });
    const { c, errors } = client(edge.fetch, { verifyLog: true });
    await c.ready();
    expect(c.revision).toBe(1);
    expect(edge.last("/v1/log/proof")?.url).toContain("revision=1");

    // r2 is served but never logged (a NanoFlags-side insider skipping the log).
    const unlogged: Published = { bundle: makeBundle(2), text: JSON.stringify(makeBundle(2)), checksum: "c2", evidence: p1.evidence };
    edge.routes["/v1/bundle"] = await response(unlogged, { evidence: false });
    edge.routes["/v1/log/proof"] = new Response("{}", { status: 404 });
    await c.refresh();
    expect(c.revision).toBe(1);
    expect(errors.at(-1)?.code).toBe("log");
    expect(errors.at(-1)?.message).toContain("not in the transparency log");
  });

  it("a forked log (a different history shown to this client) is rejected by the consistency check", async () => {
    const log = new TestLog();
    const p1 = await publish(log, makeBundle(1));
    const edge = mockRoutes({ "/v1/bundle": await response(p1) });
    const { c, errors } = client(edge.fetch, { verifyLog: true });
    await c.ready();

    // A second log whose first entry differs: the attacker rewrote history and shows a consistent-looking tree.
    const fork = new TestLog();
    await publish(fork, makeBundle(1), { loggedText: "{\"rewritten\":true}" });
    const p2 = await publish(fork, makeBundle(2));
    edge.routes["/v1/bundle"] = await response(p2);
    edge.routes["/v1/log/consistency"] = new Response(JSON.stringify({ proof: fork.consistency(1, 2) }));
    await c.refresh();
    expect(c.revision).toBe(1);
    expect(errors.at(-1)?.code).toBe("log");
    expect(errors.at(-1)?.message).toContain("not consistent");
  });

  it("an honest next head is checked for consistency and adopted", async () => {
    const log = new TestLog();
    const p1 = await publish(log, makeBundle(1));
    const edge = mockRoutes({ "/v1/bundle": await response(p1) });
    const { c, errors } = client(edge.fetch, { verifyLog: true });
    await c.ready();
    const p2 = await publish(log, makeBundle(2));
    await publish(log, makeBundle(3)); // the head grew further meanwhile
    p2.evidence = { ...p2.evidence, proof: log.inclusion(1), head: await head(log) };
    edge.routes["/v1/bundle"] = await response(p2);
    edge.routes["/v1/log/consistency"] = (call) => new Response(JSON.stringify({ proof: log.consistency(Number(new URL(call.url).searchParams.get("first")), Number(new URL(call.url).searchParams.get("second"))) }));
    await c.refresh();
    expect(c.revision).toBe(2);
    expect(errors).toEqual([]);
    expect(edge.last("/v1/log/consistency")?.url).toContain("first=1&second=3");
  });

  it("a tree head that NanoFlags did not sign is rejected", async () => {
    const log = new TestLog();
    const p = await publish(log, makeBundle(1));
    p.evidence = { ...p.evidence, head: await head(log, rogue) };
    const edge = mockRoutes({ "/v1/bundle": await response(p) });
    const { c, errors } = client(edge.fetch, { verifyLog: true });
    await c.ready();
    expect(c.revision).toBeNull();
    expect(errors.at(-1)?.message).toContain("not signed by NanoFlags");
  });

  it("verify: false cannot be combined: nothing is applied and a config error says why", async () => {
    const log = new TestLog();
    const edge = mockRoutes({ "/v1/bundle": await response(await publish(log, makeBundle(1))) });
    const { c, errors } = client(edge.fetch, { verifyLog: true, verify: false });
    await c.ready();
    expect(c.revision).toBeNull();
    expect(errors.some((e) => e.code === "config")).toBe(true);
  });
});

/* ---------------- client: coSignerKeys ---------------- */

describe("coSignerKeys", () => {
  it("a bundle with a valid customer co-signature is adopted", async () => {
    const log = new TestLog();
    const edge = mockRoutes({ "/v1/bundle": await response(await publish(log, makeBundle(1), { mode: "cosigned", kid: "ci-1" }), { cosign: customer }) });
    const { c, errors } = client(edge.fetch, { coSignerKeys: [customer.publicJwk] });
    await c.ready();
    expect(c.revision).toBe(1);
    expect(errors).toEqual([]);
  });

  it("a bundle without the co-signature, or co-signed by another key, is rejected", async () => {
    const log = new TestLog();
    const edge = mockRoutes({ "/v1/bundle": await response(await publish(log, makeBundle(1))) });
    const { c, errors } = client(edge.fetch, { coSignerKeys: [customer.publicJwk] });
    await c.ready();
    expect(c.revision).toBeNull();
    expect(errors.at(-1)?.code).toBe("cosign");
    const impostor = await makeSigner("ci-1");
    edge.routes["/v1/bundle"] = await response(await publish(log, makeBundle(2)), { cosign: impostor });
    await c.refresh();
    expect(c.revision).toBeNull();
    expect(errors.at(-1)?.message).toContain("does not verify");
  });

  it("kill switch: an un-co-signed revision that only turns flags off is accepted (default), anything else is not", async () => {
    const log = new TestLog();
    const edge = mockRoutes({ "/v1/bundle": await response(await publish(log, makeBundle(1), { mode: "cosigned", kid: "ci-1" }), { cosign: customer }) });
    const { c, errors } = client(edge.fetch, { coSignerKeys: [customer.publicJwk], verifyLog: true });
    await c.ready();
    expect(c.boolean("checkout-v2", false, { email: "a@nanoflags.dev" })).toBe(true);

    // A sneaky "emergency" that changes a value is refused.
    const sneaky = makeBundle(2);
    sneaky.flags["max-items"] = { ...sneaky.flags["max-items"]!, default: 999 };
    sneaky.flags["search-ranking"] = makeBundle(1).flags["search-ranking"]!;
    edge.routes["/v1/bundle"] = await response(await publish(log, sneaky, { mode: "emergency" }));
    edge.routes["/v1/log/consistency"] = (call) => new Response(JSON.stringify({ proof: log.consistency(Number(new URL(call.url).searchParams.get("first")), Number(new URL(call.url).searchParams.get("second"))) }));
    await c.refresh();
    expect(c.revision).toBe(1);
    expect(errors.at(-1)?.code).toBe("cosign");

    const killed = makeBundle(3);
    killed.flags["checkout-v2"] = { ...killed.flags["checkout-v2"]!, enabled: false };
    killed.flags["search-ranking"] = makeBundle(1).flags["search-ranking"]!;
    edge.routes["/v1/bundle"] = await response(await publish(log, killed, { mode: "emergency" }));
    await c.refresh();
    expect(c.revision).toBe(3);
    expect(c.boolean("checkout-v2", false, { email: "a@nanoflags.dev" })).toBe(false);
  });

  it("allowEmergencyWithoutCosign: false refuses kill-switch revisions too", async () => {
    const log = new TestLog();
    const edge = mockRoutes({ "/v1/bundle": await response(await publish(log, makeBundle(1)), { cosign: customer }) });
    const { c, errors } = client(edge.fetch, { coSignerKeys: [customer.publicJwk], allowEmergencyWithoutCosign: false });
    await c.ready();
    const killed = makeBundle(2);
    killed.flags["checkout-v2"] = { ...killed.flags["checkout-v2"]!, enabled: false };
    killed.flags["search-ranking"] = makeBundle(1).flags["search-ranking"]!;
    edge.routes["/v1/bundle"] = await response(await publish(log, killed));
    await c.refresh();
    expect(c.revision).toBe(1);
    expect(errors.at(-1)?.code).toBe("cosign");
  });

  it("onlyTurnsFlagsOff: kills only", () => {
    const a = makeBundle(1) as unknown as Record<string, unknown>;
    const off = makeBundle(2);
    off.flags["checkout-v2"] = { ...off.flags["checkout-v2"]!, enabled: false };
    off.flags["search-ranking"] = makeBundle(1).flags["search-ranking"]!;
    expect(onlyTurnsFlagsOff(a, off as unknown as Record<string, unknown>)).toBe(true);
    const on = structuredClone(off) as unknown as Record<string, unknown>;
    expect(onlyTurnsFlagsOff(off as unknown as Record<string, unknown>, a)).toBe(false); // turning back on is not an emergency
    expect(onlyTurnsFlagsOff(a, { ...on, segments: {} })).toBe(false);
  });
});
