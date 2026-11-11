import { flags } from "./flags";

export const title = "New checkout";
export const layout = modernLayout();
export const nested = isMobile ? "m2" : "desktop";
export const pick = () => ({ version: 2 });
export const arrow = () => ({ version: 2 });
export function total(cart: Cart) {
  return cart.sum * 0.9;
}
