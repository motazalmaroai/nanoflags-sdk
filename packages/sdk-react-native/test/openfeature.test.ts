// @vitest-environment happy-dom
/** OpenFeature (static context: @openfeature/web-sdk, @openfeature/react-sdk) on the React Native client. */
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, OpenFeature, ProviderEvents, ProviderStatus, StandardResolutionReasons } from "@openfeature/web-sdk";
import { OpenFeatureProvider, useBooleanFlagValue, useStringFlagDetails } from "@openfeature/react-sdk";
import { createClient, type ReactNativeClient } from "../src/index";
import { NanoFlagsReactNativeProvider } from "../src/openfeature";
import { BASE, CLIENT_KEY, FakeEdge, FakeSocket, makeBundle, makeSigner, waitFor } from "./helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clients: ReactNativeClient[] = [];
afterEach(async () => {
  await OpenFeature.clearProviders();
  await OpenFeature.clearContexts();
  clients.splice(0).forEach((c) => c.close());
  FakeSocket.reset();
});

async function setup(opts: { live?: boolean } = {}) {
  const signer = await makeSigner();
  const edge = new FakeEdge(signer, makeBundle(3));
  const client = createClient({ sdkKey: CLIENT_KEY, baseUrl: BASE, appState: null, verify: { publicKeys: [signer.publicJwk] }, fetch: edge.fetch, webSocket: FakeSocket as never, streaming: opts.live ?? false, pollIntervalMs: 0, events: false });
  clients.push(client);
  return { client, edge };
}

let n = 0;

describe("NanoFlagsReactNativeProvider", () => {
  it("resolves with OpenFeature's context, which also becomes the client's context", async () => {
    const { client } = await setup();
    const domain = `rn-${++n}`;
    await OpenFeature.setContext(domain, { targetingKey: "u1", plan: "free" });
    await OpenFeature.setProviderAndWait(domain, new NanoFlagsReactNativeProvider({ client }));
    const of = OpenFeature.getClient(domain);
    expect(of.metadata.providerMetadata.name).toBe("nanoflags");
    expect(of.providerStatus).toBe(ProviderStatus.READY);
    expect(client.context).toEqual({ key: "u1", plan: "free" });
    expect(of.getBooleanDetails("new-checkout", true)).toMatchObject({ value: false, reason: StandardResolutionReasons.DEFAULT, flagMetadata: { revision: 3 } });

    await OpenFeature.setContext(domain, { targetingKey: "u1", plan: "vip" });
    expect(client.context).toEqual({ key: "u1", plan: "vip" });
    expect(client.boolean("new-checkout", false)).toBe(true); // NanoFlags hooks see the same user
    expect(of.getBooleanDetails("new-checkout", false)).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH, variant: "vip" });
    expect(of.getStringValue("accent", "none")).toBe("blue-r3");
    expect(of.getNumberValue("max-items", 1)).toBe(20);
    expect(of.getObjectValue("layout", {})).toEqual({ columns: 2 });
    expect(of.getStringDetails("nope", "fb")).toMatchObject({ value: "fb", errorCode: ErrorCode.FLAG_NOT_FOUND });
    expect(of.getBooleanDetails("accent", true)).toMatchObject({ value: true, errorCode: ErrorCode.TYPE_MISMATCH });
  });

  it("syncContext: false leaves the client's context alone", async () => {
    const { client } = await setup();
    client.identify({ key: "mine" });
    const domain = `rn-${++n}`;
    await OpenFeature.setContext(domain, { targetingKey: "theirs", plan: "vip" });
    await OpenFeature.setProviderAndWait(domain, new NanoFlagsReactNativeProvider({ client, syncContext: false }));
    expect(client.context).toEqual({ key: "mine" });
    expect(OpenFeature.getClient(domain).getBooleanValue("new-checkout", false)).toBe(true);
  });

  it("a pushed revision emits CONFIGURATION_CHANGED", async () => {
    const { client, edge } = await setup({ live: true });
    const domain = `rn-${++n}`;
    await OpenFeature.setProviderAndWait(domain, new NanoFlagsReactNativeProvider({ client }));
    const seen: string[] = [];
    OpenFeature.getClient(domain).addHandler(ProviderEvents.ConfigurationChanged, () => void seen.push("changed"));
    await waitFor(() => client.transport === "live");
    FakeSocket.last!.message(await edge.push(makeBundle(4)));
    await waitFor(() => seen.length === 1, 2000, "event");
    expect(OpenFeature.getClient(domain).getStringValue("accent", "")).toBe("blue-r4");
  });

  it("works with @openfeature/react-sdk hooks", async () => {
    const { client } = await setup();
    const domain = `rn-${++n}`;
    await OpenFeature.setContext(domain, { targetingKey: "u1", plan: "vip" });
    await OpenFeature.setProviderAndWait(domain, new NanoFlagsReactNativeProvider({ client }));
    const seen: Array<[boolean, string, string | undefined]> = [];
    function App(): ReactElement {
      const checkout = useBooleanFlagValue("new-checkout", false);
      const accent = useStringFlagDetails("accent", "none");
      seen.push([checkout, accent.value, accent.reason]);
      return createElement("div");
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(OpenFeatureProvider, { domain }, createElement(App))));
    expect(seen.at(-1)).toEqual([true, "blue-r3", StandardResolutionReasons.DEFAULT]);
    await act(async () => {
      await OpenFeature.setContext(domain, { targetingKey: "u1", plan: "free" });
    });
    expect(seen.at(-1)![0]).toBe(false);
    act(() => root.unmount());
  });
});
