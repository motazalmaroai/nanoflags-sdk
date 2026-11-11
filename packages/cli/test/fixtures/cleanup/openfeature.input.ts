import { OpenFeature } from "@openfeature/server-sdk";

const client = OpenFeature.getClient();

export async function handler(req: Req) {
  if (await client.getBooleanValue("checkout-v2", false, { targetingKey: req.user })) {
    return v2(req);
  }
  const on = await client.getBooleanValue("checkout-v2", false);
  return on ? v2(req) : v1(req);
}
