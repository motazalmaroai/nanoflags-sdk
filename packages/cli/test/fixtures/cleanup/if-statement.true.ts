import { flags } from "./flags";

export function checkout(ctx: Ctx) {
  // direct call as the whole condition, with else
  renderNewCheckout(ctx);
  track("new");

  // no else
  preloadPayments();

  // negated

  // negated with else
  newTotals();

  // else-if chain
  if (ctx.guest) {
    guestFlow();
  } else {
    memberFlowV2();
  }

  // unbraced
  enableV2();

  // block-scoped names that are free outside: unwrapped
  const total = computeTotal(ctx);
  show(total);

  // block-scoped name that also exists outside: the braces stay
  const label = "outer";
  {
    const label = "inner";
    show(label);
  }
  return label;
}
