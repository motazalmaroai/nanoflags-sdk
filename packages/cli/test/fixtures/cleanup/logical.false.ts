import { flags } from "./flags";

export function view(user: User) {
  const legacy = user.optedOut;
  const either = user.beta || false;
  const value = user.plan && false;

  if (user.admin) {
    always();
  }
  if (log("checked")) {
    sideEffectStays();
  }
  if (user.signedIn) {
    neverRuns();
  }
  while (false) {
    tick();
  }
  return { showBanner: false, legacy, either, value };
}
