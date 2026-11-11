import { flags } from "./flags";

export function rank(items: Item[], ctx: Ctx) {
  return rankV2(items);
  const label = "new";
  switch ("relevance-v2") {
    case "relevance-v2":
      return rankV2(items, label);
    default:
      return rankV1(items, label);
  }
}
export const limit = 20 + 1;
export const precision = (20).toFixed(1);
export const columns = {"columns":3}.columns;
export const getLayout = () => ({"columns":3});
