import { OpenFeature } from "@openfeature/server-sdk";

const client = OpenFeature.getClient();

export async function handler(req: Req) {
  return v2(req);
  return v2(req);
}
