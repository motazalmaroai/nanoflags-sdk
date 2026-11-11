import { flags } from "./flags";

export const title = "Checkout";
export const layout = legacyLayout();
export const nested = isMobile ? "m1" : "desktop";
export const pick = () => ({ version: 1 });
export const arrow = () => ({ version: 1 });
export function total(cart: Cart) {
  return cart.sum * 1;
}
