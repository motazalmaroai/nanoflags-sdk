/** The same surface through the real OpenFeature web SDK (synchronous evaluation, static context). */
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, OpenFeature, ProviderEvents, ProviderStatus, StandardResolutionReasons } from "@openfeature/web-sdk";
import { NanoFlagsWebProvider } from "../src/web";
import { bundleResponse, makeBundle, offline, scripted, tick } from "./helpers";

let n = 0;
const closers: Array<() => void> = [];
async function setup(first: Response | Error, context: Record<string, string> = {}) {
  const { client, edge } = scripted(first);
  closers.push(() => client.close());
  const domain = `web-${++n}`;
  const of = OpenFeature.getClient(domain);
  const seen: string[] = [];
  for (const e of [ProviderEvents.Ready, ProviderEvents.Stale, ProviderEvents.Error, ProviderEvents.ConfigurationChanged]) of.addHandler(e, () => void seen.push(e));
  await OpenFeature.setContext(domain, context);
  let initError: unknown = null;
  await OpenFeature.setProviderAndWait(domain, new NanoFlagsWebProvider({ client })).catch((e: unknown) => (initError = e));
  return { client, edge, of, seen, domain, initError };
}

afterEach(async () => {
  await OpenFeature.clearProviders();
  await OpenFeature.clearContexts();
  for (const c of closers.splice(0)) c();
});

describe("web provider", () => {
  it("resolves synchronously with the static context", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)), { targetingKey: "u1", plan: "vip" });
    expect(of.metadata.providerMetadata.name).toBe("nanoflags");
    expect(of.getBooleanDetails("bool-fixed", false)).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH, variant: "vip-rule", flagMetadata: { revision: 7 } });
    expect(of.getBooleanDetails("bool-rollout", false)).toMatchObject({ reason: StandardResolutionReasons.SPLIT, variant: "half" });
    expect(of.getBooleanDetails("bool-off", true)).toMatchObject({ value: false, reason: StandardResolutionReasons.DISABLED });
    expect(of.getStringValue("str", "fb")).toBe("v7");
    expect(of.getNumberValue("num", 1)).toBe(20);
    expect(of.getObjectValue("obj", {})).toEqual({ columns: 3 });
  });

  it("errors return the default value with an error code", async () => {
    const { of } = await setup(bundleResponse(makeBundle(7)));
    expect(of.getStringDetails("nope", "fb")).toMatchObject({ value: "fb", reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.FLAG_NOT_FOUND });
    expect(of.getBooleanDetails("str", true)).toMatchObject({ value: true, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.TYPE_MISMATCH });
  });

  it("a context change is picked up by the next evaluation", async () => {
    const { of, domain } = await setup(bundleResponse(makeBundle(7)), { targetingKey: "u1", plan: "free" });
    expect(of.getBooleanValue("bool-fixed", false)).toBe(false);
    await OpenFeature.setContext(domain, { targetingKey: "u1", plan: "vip" });
    expect(of.getBooleanValue("bool-fixed", false)).toBe(true);
  });

  it("status and events follow the client", async () => {
    const { of, seen, client, edge } = await setup(bundleResponse(makeBundle(7)));
    expect(of.providerStatus).toBe(ProviderStatus.READY);
    expect(seen).toContain(ProviderEvents.Ready);
    seen.length = 0; // (the web SDK also replays READY to handlers added while the previous provider was ready)
    edge.next = offline();
    await client.refresh();
    await tick();
    expect(of.providerStatus).toBe(ProviderStatus.STALE);
    edge.next = bundleResponse(makeBundle(8));
    await client.refresh();
    await tick();
    expect(of.providerStatus).toBe(ProviderStatus.READY);
    expect(of.getStringValue("str", "fb")).toBe("v8");
    expect(seen).toEqual([ProviderEvents.Stale, ProviderEvents.Ready, ProviderEvents.ConfigurationChanged]);
  });

  it("no configuration: ERROR status and default values", async () => {
    const { of, initError } = await setup(offline());
    expect(initError).toBeInstanceOf(Error);
    expect(of.providerStatus).toBe(ProviderStatus.ERROR);
    expect(of.getBooleanDetails("bool-fixed", true)).toMatchObject({ value: true, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.PROVIDER_NOT_READY });
  });
});
