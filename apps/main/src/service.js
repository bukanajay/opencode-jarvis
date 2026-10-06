import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

let client = null;
let endpoint = null;

export async function ensureClient() {
  if (client) return { client, endpoint };
  endpoint = await Service.ensure();
  client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  return { client, endpoint };
}

export function getClient() {
  if (!client) throw new Error("client not ready: call ensureClient first");
  return client;
}
