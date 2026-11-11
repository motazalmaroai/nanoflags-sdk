export async function handler(client) {
  const on = await client.getBooleanValue("checkout-v2", false);
  const d = await client.getStringDetails("search-ranking", "x");
  return { on, d };
}
