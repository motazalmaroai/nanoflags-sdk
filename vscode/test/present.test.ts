import { describe, expect, it } from "vitest";
import type { Flag } from "../src/api";
import { closest, dashboardFlagUrl, formatValue, hoverMarkdown, problems } from "../src/present";
import { scanText } from "../src/scanner";

const flag = (key: string, extra: Partial<Flag> = {}): Flag => ({
  id: key, key, name: key, description: "", type: "boolean", purpose: "release", permanent: false, clientExposed: false, archivedAt: null, createdAt: "", ...extra,
});
const env = (key: string, publishedRevision: number) => ({ id: key, key, name: key[0]!.toUpperCase() + key.slice(1), sort: 0, isProtected: false, requireApproval: false, publishedRevision });

describe("presentation", () => {
  it("builds dashboard links", () => {
    expect(dashboardFlagUrl(undefined, "new-checkout")).toBe("https://app.nanoflags.io/app/flags/new-checkout");
    expect(dashboardFlagUrl("https://flags.example.com/", "a b")).toBe("https://flags.example.com/app/flags/a%20b");
  });

  it("formats values compactly", () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue("x".repeat(50), 10)).toBe(`"xxxxxxxx…`);
  });

  it("renders the hover with per-environment status and the draft when it differs", () => {
    const text = hoverMarkdown(
      flag("new-checkout", { name: "New checkout", description: "Uses *markdown*", clientExposed: true }),
      [
        { environment: env("development", 3), published: { enabled: true, rules: [1, 2], default: false, off: false }, draft: { enabled: true, rules: [1, 2], default: false, off: false } },
        { environment: env("staging", 2), published: { enabled: false, rules: [], default: true, off: false }, draft: { enabled: true, rules: [], default: true, off: false } },
        { environment: env("production", 0), published: null, draft: { enabled: false, rules: [], default: false, off: false } },
      ],
      undefined,
      "Web app",
    );
    expect(text).toContain("**New checkout** `new-checkout`");
    expect(text).toContain("boolean · release · client-exposed");
    expect(text).toContain("Uses \\*markdown\\*");
    expect(text).toContain("| Development | On · default false · 2 rules | same |");
    expect(text).toContain("| Staging | Off · serves false | On · default true |");
    expect(text).toContain("| Production | not published | Off · serves false |");
    expect(text).toContain("[Open in NanoFlags](https://app.nanoflags.io/app/flags/new-checkout)");
  });

  it("marks archived flags in the hover", () => {
    expect(hoverMarkdown(flag("old", { archivedAt: "2026-05-01T10:00:00Z" }), [], undefined)).toContain("**Archived** on 2026-05-01");
  });

  it("reports unknown keys only for strong references, and archived flags", () => {
    const src = `flags.boolean("nope"); z.string("weak"); flags.boolean("old"); flags.boolean("ok")`;
    const known = new Map([["old", flag("old", { archivedAt: "2026-01-01" })], ["ok", flag("ok")]]);
    const p = problems(scanText(src, "typescript"), (k) => known.get(k), "Web");
    expect(p.map((x) => `${x.kind}:${x.key}`)).toEqual(["unknown:nope", "archived:old"]);
    expect(src.slice(p[0]!.start, p[0]!.end)).toBe("nope");
  });

  it("suggests close keys", () => {
    expect(closest("new-chekout", ["new-checkout", "accent"])).toBe("new-checkout");
    expect(closest("zzz", ["new-checkout"])).toBeUndefined();
  });
});
