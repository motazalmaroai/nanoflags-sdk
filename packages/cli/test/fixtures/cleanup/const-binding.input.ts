import { flags } from "./flags";

export function page(ctx: Ctx) {
  const enabled = flags.boolean("checkout-v2", false, ctx);
  if (enabled) {
    renderNew();
  } else {
    renderOld();
  }
  const title = enabled ? "New" : "Old";
  const banner = enabled && ctx.signedIn;
  const props = { enabled, title };
  log(`enabled=${enabled}`);

  function inner() {
    // a different `enabled`: untouched
    const enabled = ctx.override;
    return enabled ? 1 : 2;
  }
  const later = () => (enabled ? inner() : 0);
  return { title, banner, props, later };
}

export function negated(ctx: Ctx) {
  const disabled = !flags.boolean("checkout-v2", false, ctx);
  if (disabled) return null;
  return render();
}

// `let` is not a constant binding: only the call is replaced
export function mutable(ctx: Ctx) {
  let on = flags.boolean("checkout-v2", false, ctx);
  if (ctx.force) on = false;
  return on;
}

// exported: the declaration stays
export const CHECKOUT_V2 = flags.boolean("checkout-v2", false);
if (CHECKOUT_V2) boot();
