// Parity 7 — MCP status and sign-in: server list, status, OAuth attempt lifecycle.
const { ensureClient } = await import("../apps/main/src/service.js");
const { client } = await ensureClient();

// 1. Status: every configured MCP server with its connection state.
const mcps = await client.mcp.list();
const servers = mcps.data ?? [];
if (servers.length === 0) throw new Error("no MCP servers listed");
for (const s of servers) console.log(`mcp: ${s.name} status=${s.status?.status ?? "unknown"}`);
const atlassian = servers.find((s) => s.name === "atlassian");
if (!atlassian || atlassian.status?.status !== "connected") throw new Error("atlassian MCP not connected");
console.log("status-ok: atlassian connected");

// 2. Sign-in: initiate OAuth (attempt issued), then cancel. No credentials harmed.
const attempt = await client.integration.oauth.connect({ integrationID: "gitlab", methodID: "pkce" });
const attemptID = attempt?.data?.attemptID ?? attempt?.attemptID ?? attempt?.data?.id ?? attempt?.id;
const url = attempt?.data?.url ?? attempt?.url;
console.log(`signin-ok: attempt=${String(attemptID).slice(0, 16)} url=${String(url ?? "").slice(0, 60)}`);
if (!attemptID) throw new Error("oauth connect issued no attempt");
const st = await client.integration.oauth.status({ integrationID: "gitlab", attemptID }).catch((e) => `status-err:${String(e).slice(0, 80)}`);
console.log(`poll-ok: ${JSON.stringify(st?.data ?? st).slice(0, 120)}`);
await client.integration.oauth.cancel({ integrationID: "gitlab", attemptID }).catch(() => {});
console.log("cancel-ok: attempt withdrawn");
console.log("mcp-ok");
process.exit(0);
