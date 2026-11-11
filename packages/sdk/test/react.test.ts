import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, type NanoFlagsClient } from "../src/index";
import { NanoFlagsProvider, useFlag, useFlagsStatus } from "../src/react";
import { BASE, SERVER_KEY, bundleResponse, makeBundle, mockEdge } from "./helpers";

const clients: NanoFlagsClient[] = [];
const make = (opts: Partial<Parameters<typeof createClient>[0]>) => {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, streaming: false, pollIntervalMs: 0, events: false, ...opts });
  clients.push(c);
  return c;
};
afterEach(() => clients.splice(0).forEach((c) => c.close()));

function Probe(): ReactElement {
  const checkout = useFlag("checkout-v2", false);
  const override = useFlag("checkout-v2", false, { region: "DE" });
  const ranking = useFlag("search-ranking", "fallback");
  const items = useFlag("max-items", 1);
  const layout = useFlag("layout", { columns: 1 });
  const mismatch = useFlag("search-ranking", 7);
  const { status, revision, hasBundle } = useFlagsStatus();
  return createElement("pre", null, JSON.stringify({ checkout, override, ranking, items, layout, mismatch, status, revision, hasBundle }));
}

const render = (client: NanoFlagsClient, context = { key: "user-1", signedIn: true, region: "US" }) =>
  JSON.parse(
    renderToString(createElement(NanoFlagsProvider, { client, context }, createElement(Probe)))
      .replace(/^<pre>|<\/pre>$/g, "")
      .replace(/&quot;/g, '"'),
  ) as Record<string, unknown>;

describe("react bindings", () => {
  it("renders fallbacks while no bundle is loaded", () => {
    const client = make({ fetch: mockEdge().fetch });
    expect(render(client)).toEqual({ checkout: false, override: false, ranking: "fallback", items: 1, layout: { columns: 1 }, mismatch: 7, status: "not-ready", revision: null, hasBundle: false });
  });

  it("renders flag values from the provider context, with per-hook overrides and typed fallbacks", async () => {
    const client = make({ fetch: mockEdge({ bundle: bundleResponse(makeBundle(3)) }).fetch });
    await client.ready();
    expect(render(client)).toEqual({ checkout: true, override: false, ranking: "relevance-v3", items: 20, layout: { columns: 3 }, mismatch: 7, status: "ready", revision: 3, hasBundle: true });
  });

  it("works with a bootstrap bundle during server rendering (no network needed)", () => {
    const client = make({ fetch: mockEdge().fetch, bootstrap: makeBundle(2) });
    expect(render(client)).toMatchObject({ checkout: true, ranking: "relevance-v2", status: "ready", revision: 2 });
  });

  it("the external store notifies subscribers so components re-render on updates", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const client = make({ fetch: edge.fetch });
    await client.ready();
    let notified = 0;
    const before = client.version;
    const unsubscribe = client.subscribe(() => notified++);
    edge.replies.bundle = bundleResponse(makeBundle(4));
    await client.refresh();
    expect(notified).toBe(1);
    expect(client.version).not.toBe(before);
    expect(render(client)).toMatchObject({ ranking: "relevance-v4", revision: 4 });
    unsubscribe();
  });

  it("hooks throw a clear error outside the provider", () => {
    expect(() => renderToString(createElement(Probe))).toThrow(/NanoFlagsProvider/);
  });
});
