import { flags } from "./flags";

export function rank(items: Item[], ctx: Ctx) {
  if (flags.string("search-ranking", "relevance-v1", ctx) === "relevance-v2") {
    return rankV2(items);
  }
  const algo = flags.string("search-ranking", "relevance-v1", ctx);
  const label = algo !== "relevance-v1" ? "new" : "old";
  switch (algo) {
    case "relevance-v2":
      return rankV2(items, label);
    default:
      return rankV1(items, label);
  }
}
export const limit = flags.number("max-items", 10) + 1;
export const precision = flags.number("max-items", 10).toFixed(1);
export const columns = flags.json("layout", { columns: 1 }).columns;
export const getLayout = () => flags.json("layout", { columns: 1 });
