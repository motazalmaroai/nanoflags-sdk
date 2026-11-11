import { flags } from "./flags";

export function checkout(ctx: { key: string }) {
  if (flags.boolean("checkout-v2", false, ctx)) {
    return "v2";
  }
  const limit = flags.number("max-items", 10, ctx);
  const details = flags.evaluate("search-ranking", "relevance-v1", ctx);
  const template = flags.string(`search-ranking`, "relevance-v1");
  // not references:
  const unknown = flags.boolean("not-a-flag", false);
  const notACall = "checkout-v2";
  const otherFunction = track("checkout-v2");
  const dynamic = flags.boolean(notACall, false);
  const concatenated = flags.boolean("checkout-" + "v2", false);
  return { limit, details, template, unknown, otherFunction, dynamic, concatenated };
}
