import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, planConnector, splitValues, connectorView, connectorsSummary, briefConnectorLine, serverName, loadConnectors, saveConnectors } from "../../apps/main/src/connectors.js";
import { validateAction } from "../../apps/main/src/actions.js";
import { briefFacts } from "../../apps/main/src/brief.js";

const GH = "github_pat_" + "A".repeat(40);

test("catalog: the six systems, each buildable", () => {
  assert.deepEqual(CATALOG.map((c) => c.id), ["github", "slack", "google-calendar", "gmail", "linear", "stripe"]);
  for (const c of CATALOG) assert.ok(c.purpose && c.briefHint && c.fields.length, c.id);
  assert.equal(CATALOG.find((c) => c.id === "gmail").verified, false, "Gmail endpoint is not confirmed and says so");
});

test("planConnector: configs per service", () => {
  const gh = planConnector("github", { token: GH });
  assert.equal(gh.server, "jarvis-github");
  assert.deepEqual(gh.config, { type: "remote", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: `Bearer ${GH}` } });
  assert.equal(planConnector("linear", {}).config.url, "https://mcp.linear.app/mcp/readonly", "read-only by default, OAuth");
  assert.equal(planConnector("linear", {}, { readOnly: false }).config.url, "https://mcp.linear.app/mcp");
  const lk = planConnector("linear", { apiKey: "lin_api_" + "x".repeat(30) });
  assert.equal(lk.config.oauth, false);
  const cal = planConnector("google-calendar", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secretvalue" });
  assert.match(cal.config.oauth.scope, /calendar\.readonly$/);
  const sl = planConnector("slack", { clientId: "1234.5678", clientSecret: "a".repeat(32) });
  assert.deepEqual(sl.config.oauth, { client_id: "1234.5678", client_secret: "a".repeat(32) });
  const st = planConnector("stripe", { key: "rk_live_" + "Z".repeat(30) });
  assert.equal(st.config.url, "https://mcp.stripe.com");
});

test("planConnector: refuses bad or dangerous credentials", () => {
  assert.throws(() => planConnector("github", {}), /required/);
  assert.throws(() => planConnector("github", { token: "hunter2" }), /doesn't look like/);
  assert.throws(() => planConnector("stripe", { key: "sk_live_" + "Z".repeat(30) }), /doesn't look like|restricted key/);
  assert.throws(() => planConnector("nope", {}), /unknown connector/);
});

test("splitValues: secrets to the keychain, the rest to settings", () => {
  assert.deepEqual(splitValues("google-calendar", { clientId: "x.apps.googleusercontent.com", clientSecret: "s3cret" }), { secret: { clientSecret: "s3cret" }, plain: { clientId: "x.apps.googleusercontent.com" } });
  assert.deepEqual(splitValues("github", { token: GH }), { secret: { token: GH }, plain: {} });
});

test("store round-trip never contains secrets", () => {
  saveConnectors({ github: { enabled: true, readOnly: true, values: {} } });
  assert.deepEqual(loadConnectors(), { github: { enabled: true, readOnly: true, values: {} } });
});

test("connectorView + summaries", () => {
  const view = connectorView(
    { github: { enabled: true, readOnly: true }, linear: { enabled: true, readOnly: true }, stripe: { enabled: false } },
    [{ name: "jarvis-github", status: { status: "connected" } }, { name: "jarvis-linear", status: { status: "needs_auth", error: "sign in" } }, { name: "aws-mcp", status: { status: "connected" } }],
  );
  const row = (id) => view.rows.find((r) => r.id === id);
  assert.equal(row("github").status, "connected");
  assert.equal(row("linear").status, "needs_auth");
  assert.equal(row("stripe").enabled, false);
  assert.equal(row("gmail").configured, false);
  assert.deepEqual(view.yours, [{ id: "aws-mcp", name: "aws-mcp", status: "connected", yours: true }]);
  assert.ok(row("github").fields.every((f) => !("pattern" in f)), "no regexes leak to the deck");
  const sum = connectorsSummary(view);
  assert.match(sum, /connected: GitHub \(read-only\)/);
  assert.match(sum, /not ready: Linear \(needs_auth: sign in\)/);
  assert.match(sum, /your own MCP servers: aws-mcp \(connected\)/);
  assert.match(sum, /available to set up: Slack \(workspace search\), Google Calendar, Gmail/);
  assert.match(briefConnectorLine(view), /GitHub \(open PRs waiting on review/);
  assert.equal(briefConnectorLine(connectorView({}, [])), "");
  assert.match(briefFacts({ now: 0, sinceMs: 0, routinesLine: briefConnectorLine(view) }), /Connected systems to check/);
  assert.equal(serverName("google-calendar"), "jarvis-google-calendar");
});

test("connector action", () => {
  assert.deepEqual(validateAction({ action: "connector", op: "open", id: "github" }), { action: "connector", op: "open", id: "github" });
  assert.throws(() => validateAction({ action: "connector", op: "open", id: "facebook" }), /id is/);
  assert.throws(() => validateAction({ action: "connector", op: "connect", id: "github", token: "x" }), /unexpected token|op is/);
});
