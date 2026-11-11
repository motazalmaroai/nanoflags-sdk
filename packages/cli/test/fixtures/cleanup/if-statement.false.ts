import { flags } from "./flags";

export function checkout(ctx: Ctx) {
  // direct call as the whole condition, with else
  renderOldCheckout(ctx);

  // no else

  // negated
  legacyBanner();

  // negated with else
  legacyTotals();

  // else-if chain
  if (ctx.guest) {
    guestFlow();
  } else {
    memberFlow();
  }

  // unbraced
  disableV2();

  // block-scoped names that are free outside: unwrapped

  // block-scoped name that also exists outside: the braces stay
  const label = "outer";
  return label;
}
