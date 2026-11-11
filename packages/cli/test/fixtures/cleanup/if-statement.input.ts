import { flags } from "./flags";

export function checkout(ctx: Ctx) {
  // direct call as the whole condition, with else
  if (flags.boolean("checkout-v2", false, ctx)) {
    renderNewCheckout(ctx);
    track("new");
  } else {
    renderOldCheckout(ctx);
  }

  // no else
  if (flags.boolean("checkout-v2", false, ctx)) {
    preloadPayments();
  }

  // negated
  if (!flags.boolean("checkout-v2", false, ctx)) {
    legacyBanner();
  }

  // negated with else
  if (!flags.boolean("checkout-v2", false, ctx)) {
    legacyTotals();
  } else {
    newTotals();
  }

  // else-if chain
  if (ctx.guest) {
    guestFlow();
  } else if (flags.boolean("checkout-v2", false, ctx)) {
    memberFlowV2();
  } else {
    memberFlow();
  }

  // unbraced
  if (flags.boolean("checkout-v2", false, ctx)) enableV2();
  else disableV2();

  // block-scoped names that are free outside: unwrapped
  if (flags.boolean("checkout-v2", false, ctx)) {
    const total = computeTotal(ctx);
    show(total);
  }

  // block-scoped name that also exists outside: the braces stay
  const label = "outer";
  if (flags.boolean("checkout-v2", false, ctx)) {
    const label = "inner";
    show(label);
  }
  return label;
}
