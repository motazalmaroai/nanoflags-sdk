import { flags } from "./flags";

export const title = flags.boolean("checkout-v2", false) ? "New checkout" : "Checkout";
export const layout = !flags.boolean("checkout-v2", false) ? legacyLayout() : modernLayout();
export const nested = isMobile ? (flags.boolean("checkout-v2", false) ? "m2" : "m1") : "desktop";
export const pick = () => (flags.boolean("checkout-v2", false) ? { version: 2 } : { version: 1 });
export const arrow = () => flags.boolean("checkout-v2", false) ? { version: 2 } : { version: 1 };
export function total(cart: Cart) {
  return cart.sum * (flags.boolean("checkout-v2", false, { key: cart.user }) ? 0.9 : 1);
}
