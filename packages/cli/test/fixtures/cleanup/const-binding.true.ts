import { flags } from "./flags";

export function page(ctx: Ctx) {
  renderNew();
  const title = "New";
  const banner = ctx.signedIn;
  const props = { enabled: true, title };
  log(`enabled=${true}`);

  function inner() {
    // a different `enabled`: untouched
    const enabled = ctx.override;
    return enabled ? 1 : 2;
  }
  const later = () => (inner());
  return { title, banner, props, later };
}

export function negated(ctx: Ctx) {
  return render();
}

// `let` is not a constant binding: only the call is replaced
export function mutable(ctx: Ctx) {
  let on = true;
  if (ctx.force) on = false;
  return on;
}

// exported: the declaration stays
export const CHECKOUT_V2 = true;
boot();
