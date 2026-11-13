// @vitest-environment happy-dom
/** Hooks: re-render on identify() and on new revisions, Suspense-free loading state. Rendered with react-dom (the hooks use no native components). */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { NanoFlagsProvider, createClient, useAllFlags, useBoolFlag, useFlag, useFlagDetail, useNanoFlags, type ReactNativeClient } from "../src/index";
import { BASE, CLIENT_KEY, FakeEdge, makeBundle, makeSigner, waitFor } from "./helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

async function setup(prepare?: (edge: FakeEdge) => void) {
  const signer = await makeSigner();
  const edge = new FakeEdge(signer, makeBundle(3));
  prepare?.(edge);
  const client = createClient({ sdkKey: CLIENT_KEY, baseUrl: BASE, appState: null, verify: { publicKeys: [signer.publicJwk] }, fetch: edge.fetch, streaming: false, pollIntervalMs: 0, events: false, context: { key: "u1", plan: "free" } });
  cleanup.push(() => client.close());
  return { client, edge };
}

let renders: Array<Record<string, unknown>> = [];
let identifyFromHook: ((ctx: Record<string, string>) => void) | null = null;

function Probe(): ReactElement {
  const state = useNanoFlags();
  identifyFromHook = state.identify;
  const checkout = useBoolFlag("new-checkout");
  const accent = useFlag("accent", "none");
  const items = useFlag("max-items", 1);
  const detail = useFlagDetail("new-checkout", false);
  const all = useAllFlags();
  renders.push({ loading: state.loading, status: state.status, revision: state.revision, hasBundle: state.hasBundle, checkout, accent, items, reason: detail.reason, ruleId: detail.ruleId ?? null, count: Object.keys(all).length, plan: state.context.plan });
  return createElement("div", null, String(checkout));
}

function mount(client: ReactNativeClient, context?: Record<string, string>): Root {
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(createElement(NanoFlagsProvider, { client, ...(context ? { context } : {}) }, createElement(Probe))));
  cleanup.push(() => act(() => root.unmount()));
  return root;
}

const last = () => renders.at(-1)!;

describe("hooks", () => {
  afterEach(() => {
    renders = [];
    identifyFromHook = null;
  });

  it("loading → ready without Suspense; fallbacks until the bundle arrives", async () => {
    const { client } = await setup();
    mount(client);
    expect(renders[0]).toMatchObject({ loading: true, status: "not-ready", hasBundle: false, checkout: false, accent: "none", items: 1, reason: "flag_not_found", count: 0 });
    await act(async () => {
      await client.ready();
    });
    await waitFor(() => last().loading === false);
    expect(last()).toMatchObject({ loading: false, status: "ready", revision: 3, hasBundle: true, checkout: false, accent: "blue-r3", items: 20, reason: "default", count: 4, plan: "free" });
  });

  it("identify() from the hook re-renders every flag with the new context, with no request", async () => {
    const { client, edge } = await setup();
    mount(client);
    await act(async () => {
      await client.ready();
    });
    const requests = edge.calls.length;
    act(() => identifyFromHook!({ key: "u1", plan: "vip" }));
    expect(last()).toMatchObject({ checkout: true, reason: "rule_match", ruleId: "vip", plan: "vip" });
    act(() => client.identify({ key: "u2" }));
    expect(last()).toMatchObject({ checkout: false, plan: undefined });
    expect(edge.calls.length).toBe(requests);
  });

  it("a new revision re-renders", async () => {
    const { client, edge } = await setup();
    mount(client);
    await act(async () => {
      await client.ready();
    });
    edge.bundle = makeBundle(4);
    await act(async () => {
      await client.refresh();
    });
    expect(last()).toMatchObject({ revision: 4, accent: "blue-r4" });
  });

  it("provider context is merged over the identified context", async () => {
    const { client } = await setup();
    mount(client, { plan: "vip" });
    await act(async () => {
      await client.ready();
    });
    await waitFor(() => last().status === "ready");
    expect(last()).toMatchObject({ checkout: true, plan: "free" });
  });

  it("an offline start settles (loading false) with fallbacks", async () => {
    const { client } = await setup((edge) => (edge.offline = true));
    mount(client);
    await act(async () => {
      await client.ready();
    });
    await waitFor(() => last().loading === false);
    expect(last()).toMatchObject({ loading: false, status: "not-ready", checkout: false, accent: "none" });
  });

  it("hooks outside the provider throw a clear error", () => {
    const el = document.createElement("div");
    const root = createRoot(el);
    const errors: unknown[] = [];
    function Boom(): ReactElement {
      try {
        useNanoFlags();
      } catch (e) {
        errors.push(e);
      }
      return createElement("div");
    }
    act(() => root.render(createElement(Boom)));
    act(() => root.unmount());
    expect(String(errors[0])).toMatch(/NanoFlagsProvider/);
  });
});
