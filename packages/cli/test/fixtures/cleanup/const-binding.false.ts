import { flags } from "./flags";

export function page(ctx: Ctx) {
  renderOld();
  const title = "Old";
  const props = { enabled: false, title };
  log(`enabled=${false}`);

  function inner() {
    // a different `enabled`: untouched
    const enabled = ctx.override;
    return enabled ? 1 : 2;
  }
  const later = () => 0;
  return { title, banner: false, props, later };
}

export function negated(ctx: Ctx) {
  return null;
  return render();
}

// `let` is not a constant binding: only the call is replaced
export function mutable(ctx: Ctx) {
  let on = false;
  if (ctx.force) on = false;
  return on;
}

// exported: the declaration stays
export const CHECKOUT_V2 = false;
