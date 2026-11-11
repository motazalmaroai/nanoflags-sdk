/**
 * Conformance-style tests: the provider is exercised through the real OpenFeature server SDK,
 * so what is asserted is what an application sees.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, OpenFeature, ProviderEvents, ProviderStatus, StandardResolutionReasons } from "@openfeature/server-sdk";
import { bucketOf } from "../../engine/src/index";
import { NanoFlagsProvider } from "../src/server";
import { toNanoFlagsContext } from "../src/index";
import { bundleResponse, makeBundle, offline, scripted, tick } from "./helpers";

let n = 0;
const closers: Array<() => void> = [];
async function setup(first: Response | Error, wait = true) {
  const { client, edge } = scripted(first);
  closers.push(() => client.close());
  const domain = `test-${++n}`;
  const provider = new NanoFlagsProvider({ client });
  const of = OpenFeature.getClient(domain);
  const seen: string[] = [];
  for (const e of [ProviderEvents.Ready, ProviderEvents.Stale, ProviderEvents.Error, ProviderEvents.ConfigurationChanged]) of.addHandler(e, () => void seen.push(e));
  let initError: unknown = null;
  if (wait) await OpenFeature.setProviderAndWait(domain, provider).catch((e: unknown) => (initError = e));
  return { client, edge, provider, of, seen, domain, initError };
}

afterEach(async () => {
  await OpenFeature.clearProviders();
  for (const c of closers.splice(0)) c();
});

describe("resolution", () => {
  it("provider metadata", async () => {
    const { of, provider } = await setup(bundleResponse(makeBundle(7)));
    expect(provider.metadata.name).toBe("nanoflags");
    expect(provider.runsOn).toBe("server");
    expect(of.metadata.providerMetadata.name).toBe("nanoflags");
  });

  it("boolean: fixed rule → TARGETING_MATCH with the rule id as variant", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    const d = await of.getBooleanDetails("bool-fixed", false, { targetingKey: "u1", plan: "vip" });
    expect(d).toMatchObject({ flagKey: "bool-fixed", value: true, reason: StandardResolutionReasons.TARGETING_MATCH, variant: "vip-rule", flagMetadata: { revision: 7 } });
    expect(d.errorCode).toBeUndefined();
    expect(await of.getBooleanValue("bool-fixed", false, { targetingKey: "u1", plan: "vip" })).toBe(true);
  });

  it("no rule matched → DEFAULT (the flag's configured default, not the caller's)", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    const d = await of.getBooleanDetails("bool-fixed", true, { targetingKey: "u1", plan: "free" });
    expect(d).toMatchObject({ value: false, reason: StandardResolutionReasons.DEFAULT, flagMetadata: { revision: 7 } });
    expect(d.variant).toBeUndefined();
  });

  it("disabled flag → DISABLED with the configured off value", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    expect(await of.getBooleanDetails("bool-off", true)).toMatchObject({ value: false, reason: StandardResolutionReasons.DISABLED });
  });

  it("rollout rule → SPLIT, bucketed by targetingKey, deterministic", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    let inside = 0;
    for (let i = 0; i < 200; i++) {
      const key = `user-${i}`;
      const d = await of.getBooleanDetails("bool-rollout", false, { targetingKey: key });
      expect(d.reason).toBe(StandardResolutionReasons.SPLIT);
      expect(d.variant).toBe("half");
      expect(d.value).toBe(bucketOf("bool-rollout", key) < 50); // same allocation as every other NanoFlags SDK
      if (d.value) inside++;
    }
    expect(inside).toBeGreaterThan(60);
    expect(inside).toBeLessThan(140);
    // Without a targeting key there is nothing to bucket by: outside the allocation, still SPLIT.
    expect(await of.getBooleanDetails("bool-rollout", true)).toMatchObject({ value: false, reason: StandardResolutionReasons.SPLIT });
  });

  it("string, number and object flags", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    expect(await of.getStringDetails("str", "fb")).toMatchObject({ value: "v7", reason: StandardResolutionReasons.DEFAULT });
    expect(await of.getNumberDetails("num", 1)).toMatchObject({ value: 20, reason: StandardResolutionReasons.DEFAULT });
    expect(await of.getObjectDetails("obj", {})).toMatchObject({ value: { columns: 3 }, reason: StandardResolutionReasons.DEFAULT });
    // Object resolution accepts any JSON value, as NanoFlags json flags do.
    expect(await of.getObjectValue("str", {})).toBe("v7");
  });

  it("unknown flag → default value, ERROR, FLAG_NOT_FOUND", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    const d = await of.getStringDetails("nope", "fb");
    expect(d).toMatchObject({ value: "fb", reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.FLAG_NOT_FOUND });
    expect(d.errorMessage).toContain("nope");
  });

  it("wrong type → default value, ERROR, TYPE_MISMATCH", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    expect(await of.getBooleanDetails("str", true)).toMatchObject({ value: true, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.TYPE_MISMATCH });
    expect(await of.getStringDetails("num", "fb")).toMatchObject({ value: "fb", errorCode: ErrorCode.TYPE_MISMATCH });
    expect(await of.getNumberDetails("bool-off", 5)).toMatchObject({ value: 5, errorCode: ErrorCode.TYPE_MISMATCH });
  });

  it("malformed configuration → default value, ERROR, GENERAL", async () => {
    const broken = makeBundle(7, { broken: { type: "boolean", enabled: true, default: true, off: false, rules: null } as never });
    const { of } = await setup(bundleResponse(broken));
    expect(await of.getBooleanDetails("broken", false)).toMatchObject({ value: false, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.GENERAL });
  });

  it("context mapping: targetingKey → key, dates → ISO strings, nested values kept", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    expect(await of.getStringValue("by-date", "fb", { targetingKey: "u1", signedUp: new Date("2026-01-02T03:04:05Z") })).toBe("yes");
    expect(toNanoFlagsContext({ targetingKey: "u1", key: "ignored", plan: "vip", n: 3, flag: true, tags: ["a", new Date(0)], nested: { a: { b: 1 } }, missing: undefined } as never)).toEqual({
      key: "u1",
      plan: "vip",
      n: 3,
      flag: true,
      tags: ["a", "1970-01-01T00:00:00.000Z"],
      nested: { a: { b: 1 } },
    });
    expect(toNanoFlagsContext({ key: "from-attribute" })).toEqual({ key: "from-attribute" });
    expect(toNanoFlagsContext(undefined)).toEqual({});
  });

  it("global, client and invocation context are merged by the SDK before they reach the provider", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    of.setContext({ plan: "vip" });
    expect(await of.getBooleanValue("bool-fixed", false, { targetingKey: "u1" })).toBe(true);
    expect(await of.getBooleanValue("bool-fixed", false, { targetingKey: "u1", plan: "free" })).toBe(false);
  });

  it("evaluator option: evaluations go to a session-scoped evaluator", async () => {
    const { client } = scripted(bundleResponse(makeBundle(7)));
    closers.push(() => client.close());
    const provider = new NanoFlagsProvider({ client, evaluator: () => ({ evaluate: (key, fallback, ctx) => client.evaluate(key, fallback, { ...ctx, plan: "vip" }) }) });
    await OpenFeature.setProviderAndWait("evaluator", provider);
    expect(await OpenFeature.getClient("evaluator").getBooleanValue("bool-fixed", false, { targetingKey: "u1" })).toBe(true);
  });
});

describe("status and events", () => {
  it("READY after initialization", async () => {
    const { of, seen, initError } = await setup(bundleResponse(makeBundle(7)));
    expect(initError).toBeNull();
    expect(of.providerStatus).toBe(ProviderStatus.READY);
    expect(seen).toEqual([ProviderEvents.Ready]);
  });

  it("no configuration: ERROR, defaults with PROVIDER_NOT_READY details; READY once a bundle arrives", async () => {
    const { of, seen, initError, client, edge } = await setup(offline());
    expect(initError).toBeInstanceOf(Error);
    expect(of.providerStatus).toBe(ProviderStatus.ERROR);
    expect(seen).toEqual([ProviderEvents.Error]);
    expect(await of.getBooleanDetails("bool-fixed", true, { plan: "vip" })).toMatchObject({ value: true, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.PROVIDER_NOT_READY });

    edge.next = bundleResponse(makeBundle(8));
    await client.refresh();
    await tick();
    expect(of.providerStatus).toBe(ProviderStatus.READY);
    expect(seen).toEqual([ProviderEvents.Error, ProviderEvents.Ready, ProviderEvents.ConfigurationChanged]);
    expect(await of.getStringValue("str", "fb")).toBe("v8");
  });

  it("a failed revalidation → STALE (evaluations continue); recovery → READY", async () => {
    const { of, seen, client, edge } = await setup(bundleResponse(makeBundle(7)));
    edge.next = offline();
    await client.refresh();
    await tick();
    expect(of.providerStatus).toBe(ProviderStatus.STALE);
    expect(await of.getStringDetails("str", "fb")).toMatchObject({ value: "v7", reason: StandardResolutionReasons.DEFAULT });
    edge.next = new Response(null, { status: 304 });
    await client.refresh();
    await tick();
    expect(of.providerStatus).toBe(ProviderStatus.READY);
    expect(seen).toEqual([ProviderEvents.Ready, ProviderEvents.Stale, ProviderEvents.Ready]);
  });

  it("a new revision → CONFIGURATION_CHANGED carrying the revision", async () => {
    const { of, client, edge } = await setup(bundleResponse(makeBundle(7)));
    const details: unknown[] = [];
    of.addHandler(ProviderEvents.ConfigurationChanged, (d) => details.push(d));
    edge.next = bundleResponse(makeBundle(8));
    await client.refresh();
    await tick();
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ metadata: { revision: 8 } });
    expect(of.providerStatus).toBe(ProviderStatus.READY);
    expect(await of.getStringDetails("str", "fb")).toMatchObject({ value: "v8", flagMetadata: { revision: 8 } });
  });

  it("a client that starts on a stale bundle is READY, then STALE", async () => {
    const { client, edge } = scripted(bundleResponse(makeBundle(7)));
    closers.push(() => client.close());
    await client.ready();
    edge.next = offline();
    await client.refresh();
    expect(client.status).toBe("stale");
    const of = OpenFeature.getClient("starts-stale");
    await OpenFeature.setProviderAndWait("starts-stale", new NanoFlagsProvider({ client }));
    await tick();
    expect(of.providerStatus).toBe(ProviderStatus.STALE);
  });

  it("shutdown stops event translation and leaves the client open unless closeClient is set", async () => {
    const { seen, client, edge, domain } = await setup(bundleResponse(makeBundle(7)));
    await OpenFeature.clearProviders();
    edge.next = bundleResponse(makeBundle(9));
    await client.refresh();
    await tick();
    expect(client.revision).toBe(9); // still working
    expect(seen.filter((e) => e === ProviderEvents.ConfigurationChanged)).toEqual([]);
    expect(domain).toBeTruthy();

    const owned = scripted(bundleResponse(makeBundle(7)));
    await OpenFeature.setProviderAndWait("owned", new NanoFlagsProvider({ client: owned.client, closeClient: true }));
    await OpenFeature.clearProviders();
    const before = owned.edge.requests;
    await owned.client.refresh();
    expect(owned.edge.requests).toBe(before); // closed clients no longer sync
  });
});
