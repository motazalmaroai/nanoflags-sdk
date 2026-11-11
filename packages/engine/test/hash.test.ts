import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bucketOf, evaluate, murmur3, type Bundle } from "../src/index";

describe("murmur3 (x86 32-bit) golden fixtures", () => {
  // Reference vectors for MurmurHash3_x86_32 (SMHasher-compatible implementations).
  const vectors: Array<[input: string, seed: number, expected: number]> = [
    ["", 0, 0x00000000],
    ["", 1, 0x514e28b7],
    ["", 0xffffffff, 0x81f16f39],
    ["abc", 0, 0xb3dd93fa],
    ["test", 0, 0xba6bd213],
    ["Hello, world!", 0, 0xc0363e43],
    ["Hello, world!", 1234, 0xfaf6cdb3],
    ["Hello, world!", 0x9747b28c, 0x24884cba],
    ["The quick brown fox jumps over the lazy dog", 0, 0x2e4ff723],
    ["The quick brown fox jumps over the lazy dog", 0x9747b28c, 0x2fa826cd],
    // Tail lengths 1, 2, 3 and a full block.
    ["a", 0x9747b28c, 0x7fa09ea6],
    ["aa", 0x9747b28c, 0x5d211726],
    ["aaa", 0x9747b28c, 0x283e0130],
    ["aaaa", 0x9747b28c, 0x5a97808a],
    ["ab", 0x9747b28c, 0x74875592],
    ["abc", 0x9747b28c, 0xc84a62dd],
    ["abcd", 0x9747b28c, 0xf0478627],
    ["a".repeat(256), 0x9747b28c, 0x37405bdc],
    // Non-ASCII: hashed over UTF-8 bytes (16 bytes for eight U+03C0).
    ["ππππππππ", 0x9747b28c, 0xd58063c1],
  ];

  for (const [input, seed, expected] of vectors) {
    const label = input.length > 24 ? `${input.slice(0, 24)}…(${input.length})` : input;
    it(`murmur3(${JSON.stringify(label)}, 0x${seed.toString(16)}) = 0x${expected.toString(16).padStart(8, "0")}`, () => {
      expect(murmur3(input, seed)).toBe(expected);
    });
  }

  it("defaults the seed to 0", () => {
    expect(murmur3("abc")).toBe(0xb3dd93fa);
  });

  it("hashes UTF-8 bytes, including astral code points, to an unsigned 32-bit integer", () => {
    for (const s of ["héllo", "日本語", "😀", "user-ñ-42", "Ω≈ç√∫"]) {
      const h = murmur3(s, 7);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(murmur3(s, 7)).toBe(h);
    }
    expect(murmur3("é")).not.toBe(murmur3("e"));
  });

  it("is insensitive to Unicode normalisation form (NFC vs NFD identities bucket together)", () => {
    const nfc = "café";
    const nfd = "café";
    expect(nfc).not.toBe(nfd);
    expect(murmur3(nfd)).toBe(murmur3(nfc));
    expect(bucketOf("flag", nfd)).toBe(bucketOf("flag", nfc));
  });

  it("property: always an unsigned 32-bit integer and deterministic", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.integer({ min: 0, max: 0xffffffff }), (s, seed) => {
        const h = murmur3(s, seed);
        return Number.isInteger(h) && h >= 0 && h <= 0xffffffff && murmur3(s, seed) === h;
      }),
    );
  });
});

describe("bucketOf", () => {
  it("is derived from murmur3(`seed:identity`) with two decimals of resolution", () => {
    expect(bucketOf("checkout-v2", "user-1")).toBe((murmur3("checkout-v2:user-1") % 10000) / 100);
  });

  it("is stable across calls (pinned values guard against accidental algorithm changes)", () => {
    const pinned = ["user-1", "user-2", "user-3", "anon-ü"].map((id) => bucketOf("checkout-v2", id));
    expect(["user-1", "user-2", "user-3", "anon-ü"].map((id) => bucketOf("checkout-v2", id))).toEqual(pinned);
    expect(pinned).toMatchInlineSnapshot(`
      [
        93.61,
        56.36,
        35.74,
        59.26,
      ]
    `);
  });

  it("property: bucket is in [0, 100) with at most two decimals", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (seed, id) => {
        const b = bucketOf(seed, id);
        return b >= 0 && b < 100 && Number.isInteger(Math.round(b * 100)) && Math.abs(b * 100 - Math.round(b * 100)) < 1e-9;
      }),
    );
  });

  it("distributes 10k keys at 25% within tolerance", () => {
    const n = 10_000;
    let inside = 0;
    for (let i = 0; i < n; i++) if (bucketOf("checkout-v2", `user-${i}`) < 25) inside++;
    // Binomial sd ≈ 43; ±2 percentage points is > 4.5 sd.
    expect(inside / n).toBeGreaterThan(0.23);
    expect(inside / n).toBeLessThan(0.27);
  });

  it("is roughly uniform across deciles", () => {
    const n = 10_000;
    const deciles = new Array<number>(10).fill(0);
    for (let i = 0; i < n; i++) deciles[Math.floor(bucketOf("seed-x", `id-${i}`) / 10)]!++;
    for (const count of deciles) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });

  it("allocations are independent per seed (different flags pick different users)", () => {
    const n = 10_000;
    let both = 0;
    for (let i = 0; i < n; i++) if (bucketOf("flag-a", `user-${i}`) < 50 && bucketOf("flag-b", `user-${i}`) < 50) both++;
    // Independent 50% allocations overlap in ~25% of users.
    expect(both / n).toBeGreaterThan(0.22);
    expect(both / n).toBeLessThan(0.28);
  });
});

describe("rollout monotonicity", () => {
  const bundleAt = (percentage: number): Bundle => ({
    schema: 1,
    project: "p",
    environment: "e",
    revision: 1,
    segments: {},
    flags: {
      f: { type: "boolean", enabled: true, default: false, off: false, rules: [{ id: "r1", match: "all", conditions: [], serve: { type: "rollout", percentage, value: true, otherwise: false } }] },
    },
  });

  it("raising the percentage never removes a user who was already in", () => {
    const steps = [0, 1, 5, 10, 25, 50, 75, 99.99, 100];
    for (let i = 0; i < 2000; i++) {
      let wasIn = false;
      for (const p of steps) {
        const isIn = evaluate(bundleAt(p), "f", { key: `user-${i}` }, false).value;
        if (wasIn) expect(isIn).toBe(true);
        wasIn = isIn;
      }
    }
  });

  it("property: in at p implies in at any q >= p", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.double({ min: 0, max: 100, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), (key, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const inLo = evaluate(bundleAt(lo), "f", { key }, false).value;
        const inHi = evaluate(bundleAt(hi), "f", { key }, false).value;
        return !inLo || inHi;
      }),
    );
  });

  it("0% includes nobody and 100% includes everybody", () => {
    for (let i = 0; i < 2000; i++) {
      expect(evaluate(bundleAt(0), "f", { key: `u${i}` }, true).value).toBe(false);
      expect(evaluate(bundleAt(100), "f", { key: `u${i}` }, false).value).toBe(true);
    }
  });
});
