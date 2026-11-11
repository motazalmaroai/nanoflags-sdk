import { flags } from "./flags";

export function view(user: User) {
  const showBanner = flags.boolean("checkout-v2", false) && user.signedIn;
  const legacy = flags.boolean("checkout-v2", false) || user.optedOut;
  const either = user.beta || flags.boolean("checkout-v2", false);
  const value = user.plan && flags.boolean("checkout-v2", false);

  if (user.signedIn && flags.boolean("checkout-v2", false)) {
    newFlow();
  }
  if (flags.boolean("checkout-v2", false) && user.signedIn && user.region === "US") {
    usFlow();
  }
  if (user.admin || flags.boolean("checkout-v2", false)) {
    always();
  }
  if (log("checked") || flags.boolean("checkout-v2", false)) {
    sideEffectStays();
  }
  if (user.signedIn && !flags.boolean("checkout-v2", false)) {
    neverRuns();
  }
  while (user.active && flags.boolean("checkout-v2", false)) {
    tick();
  }
  return { showBanner, legacy, either, value };
}
