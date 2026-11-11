import { flags } from "./flags";

export function view(user: User) {
  const showBanner = user.signedIn;
  const either = user.beta || true;
  const value = user.plan && true;

  if (user.signedIn) {
    newFlow();
  }
  if (user.signedIn && user.region === "US") {
    usFlow();
  }
  always();
  if (log("checked") || true) {
    sideEffectStays();
  }
  while (user.active) {
    tick();
  }
  return { showBanner, legacy: true, either, value };
}
