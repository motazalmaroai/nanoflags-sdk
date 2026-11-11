import { createClient, type Bundle, type NanoFlagsClient } from "@nanoflags/sdk";

export function makeBundle(revision: number, over: Partial<Bundle["flags"]> = {}): Bundle {
  return {
    schema: 1,
    project: "commerce",
    environment: "staging",
    revision,
    segments: {},
    flags: {
      "bool-fixed": { type: "boolean", enabled: true, default: false, off: false, rules: [{ id: "vip-rule", match: "all", conditions: [{ attribute: "plan", op: "eq", value: "vip" }], serve: { type: "fixed", value: true } }] },
      "bool-rollout": { type: "boolean", enabled: true, default: false, off: false, rules: [{ id: "half", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: true, otherwise: false } }] },
      "bool-off": { type: "boolean", enabled: false, default: true, off: false, rules: [] },
      str: { type: "string", enabled: true, default: `v${revision}`, off: "off", rules: [] },
      num: { type: "number", enabled: true, default: 20, off: 0, rules: [] },
      obj: { type: "json", enabled: true, default: { columns: 3 }, off: null, rules: [] },
      "by-date": { type: "string", enabled: true, default: "no", off: "off", rules: [{ id: "since", match: "all", conditions: [{ attribute: "signedUp", op: "eq", value: "2026-01-02T03:04:05.000Z" }], serve: { type: "fixed", value: "yes" } }] },
      ...over,
    } as Bundle["flags"],
  };
}

type Reply = Response | Error;

/** A real NanoFlags client on a scripted edge: `edge.next` is the answer to the next /v1/bundle request. */
export function scripted(first: Reply) {
  const edge = { next: first, requests: 0 };
  const fetch = (async () => {
    edge.requests++;
    if (edge.next instanceof Error) throw edge.next;
    return edge.next.clone();
  }) as unknown as typeof globalThis.fetch;
  const client: NanoFlagsClient = createClient({ sdkKey: "nf_srv_test", baseUrl: "https://edge.test", streaming: false, pollIntervalMs: 0, events: false, store: false, fetch });
  return { client, edge };
}

export function bundleResponse(bundle: Bundle): Response {
  return new Response(JSON.stringify({ revision: bundle.revision, checksum: `c${bundle.revision}`, bundle }), { status: 200, headers: { ETag: `"c${bundle.revision}"` } });
}

export const offline = () => new Error("offline");
export const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
