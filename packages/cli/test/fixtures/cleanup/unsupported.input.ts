import { flags, client } from "./flags";

export async function report(ctx: Ctx) {
  // evaluation objects, not values
  const details = flags.evaluate("checkout-v2", false, ctx);
  const of = await client.getBooleanDetails("checkout-v2", false);
  // not awaited: may be a promise
  const pending = client.getBooleanValue("checkout-v2", false);
  // arguments with side effects
  if (flags.boolean("checkout-v2", false, buildContext())) {
    a();
  }
  // wrong accessor for a boolean flag: returns its fallback today
  const s = flags.string("checkout-v2", "fallback");
  // optional call
  const maybe = flags?.boolean("checkout-v2", false);
  // fallback is not a literal: accessor unknown
  const hook = useFlag("checkout-v2", defaults.checkout);
  // key is not a literal: not recognised as a reference at all
  const dynamic = flags.boolean(KEY, false);
  return { details, of, pending, s, maybe, hook, dynamic };
}
