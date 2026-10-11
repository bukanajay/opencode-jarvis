// Connectors: the company systems a chief of staff needs (code, chat,
// calendar, email, issues, revenue), as MCP servers that Jarvis manages.
//
// Jarvis keeps the list (~/.config/jarvis/connectors.json) and the tokens
// (keychain, secrets.js); it adds enabled connectors to the OpenCode server
// at runtime with client.mcp.add and re-adds them if that server restarts.
// Your opencode.json is never edited and tokens never land in it.
//
// Read-only by default wherever the service supports it: the brain is
// read-only, and anything that writes (send, charge, comment) should go
// through a worker whose permission prompt reaches you.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CATALOG = [
  {
    id: "github",
    name: "GitHub",
    purpose: "Pull requests, CI, issues and reviews across your repos.",
    briefHint: "open PRs waiting on review, failing CI on default branches, new issues",
    auth: "token",
    fields: [{ key: "token", label: "Fine-grained personal access token", secret: true, pattern: /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/, help: "github.com → Settings → Developer settings → Fine-grained tokens. Read-only repository permissions are enough for briefs." }],
    readOnly: { default: true, note: "Use a token with read-only permissions; GitHub's remote server has no read-only switch." },
    build: (v) => ({ type: "remote", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: `Bearer ${v.token}` } }),
    verified: true,
  },
  {
    id: "slack",
    name: "Slack (workspace search)",
    purpose: "Search and read channels and threads as you (separate from the Jarvis DM bridge).",
    briefHint: "unread mentions and threads that need a reply",
    auth: "oauth-client",
    fields: [
      { key: "clientId", label: "Slack app client ID", secret: false, pattern: /^\d+\.\d+$/, help: "Slack app → Basic Information. Enable the Model Context Protocol toggle and add user scopes; Slack has no dynamic client registration." },
      { key: "clientSecret", label: "Slack app client secret", secret: true, pattern: /^[a-f0-9]{20,}$/i },
    ],
    readOnly: { default: true, note: "Grant only read user scopes (search:read, channels:history, …)." },
    build: (v) => ({ type: "remote", url: "https://mcp.slack.com/mcp", oauth: { client_id: v.clientId, client_secret: v.clientSecret } }),
    verified: true,
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    purpose: "Today's meetings, prep, scheduling (Google Workspace MCP, developer preview).",
    briefHint: "today's meetings and who they are with, conflicts, gaps for focus work",
    auth: "oauth-client",
    fields: [
      { key: "clientId", label: "Google OAuth client ID", secret: false, pattern: /\.apps\.googleusercontent\.com$/, help: "Google Cloud project → APIs & Services → Credentials → OAuth client (Desktop)." },
      { key: "clientSecret", label: "Google OAuth client secret", secret: true, pattern: /^.{10,}$/ },
    ],
    readOnly: { default: true, note: "Request the calendar read-only scope." },
    build: (v, o) => ({ type: "remote", url: "https://calendarmcp.googleapis.com/mcp/v1", oauth: { client_id: v.clientId, client_secret: v.clientSecret, scope: o.readOnly ? "https://www.googleapis.com/auth/calendar.readonly" : "https://www.googleapis.com/auth/calendar" } }),
    verified: true,
  },
  {
    id: "gmail",
    name: "Gmail",
    purpose: "Inbox triage, threads that need you, drafts for your approval.",
    briefHint: "important unread email and threads waiting on a reply",
    auth: "oauth-client",
    fields: [
      { key: "clientId", label: "Google OAuth client ID", secret: false, pattern: /\.apps\.googleusercontent\.com$/, help: "Same Google Cloud OAuth client as Calendar works." },
      { key: "clientSecret", label: "Google OAuth client secret", secret: true, pattern: /^.{10,}$/ },
      { key: "url", label: "Gmail MCP endpoint", secret: false, pattern: /^https:\/\/\S+$/, optional: true, help: "Google's Gmail endpoint is not confirmed yet; override if Google publishes a different URL." },
    ],
    readOnly: { default: true, note: "Request gmail.readonly; sending should always be a draft you approve." },
    build: (v, o) => ({ type: "remote", url: v.url || "https://gmailmcp.googleapis.com/mcp/v1", oauth: { client_id: v.clientId, client_secret: v.clientSecret, scope: o.readOnly ? "https://www.googleapis.com/auth/gmail.readonly" : "https://www.googleapis.com/auth/gmail.modify" } }),
    verified: false,
  },
  {
    id: "linear",
    name: "Linear",
    purpose: "Issues, cycles and project status.",
    briefHint: "issues assigned to the user, blocked or overdue issues, cycle progress",
    auth: "oauth",
    fields: [{ key: "apiKey", label: "Linear API key (optional; otherwise sign in with OAuth)", secret: true, pattern: /^lin_api_[A-Za-z0-9]{20,}$/, optional: true }],
    readOnly: { default: true, note: "Uses Linear's /mcp/readonly endpoint." },
    build: (v, o) => ({
      type: "remote",
      url: o.readOnly ? "https://mcp.linear.app/mcp/readonly" : "https://mcp.linear.app/mcp",
      ...(v.apiKey ? { headers: { Authorization: `Bearer ${v.apiKey}` }, oauth: false } : {}),
    }),
    verified: true,
  },
  {
    id: "stripe",
    name: "Stripe",
    purpose: "Revenue, subscriptions, failed payments and customers.",
    briefHint: "yesterday's revenue, new and churned subscriptions, failed payments",
    auth: "token",
    fields: [{ key: "key", label: "Restricted API key (rk_…)", secret: true, pattern: /^rk_(live|test)_[A-Za-z0-9]{20,}$/, help: "Dashboard → Developers → API keys → Create restricted key. Read scopes only (Customers, Charges, Subscriptions). Full secret keys (sk_) are refused." }],
    readOnly: { default: true, note: "The restricted key's scopes decide what it can do; keep them read-only." },
    build: (v) => ({ type: "remote", url: "https://mcp.stripe.com", headers: { Authorization: `Bearer ${v.key}` } }),
    verified: true,
  },
];

export const serverName = (id) => `jarvis-${id}`;
export const byId = (id) => CATALOG.find((c) => c.id === id) ?? null;

// Validate the user's values and produce the MCP server config. Pure.
export function planConnector(id, values = {}, { readOnly } = {}) {
  const c = byId(id);
  if (!c) throw new Error(`unknown connector: ${id}`);
  const v = {};
  for (const f of c.fields) {
    const raw = String(values[f.key] ?? "").trim();
    if (!raw) {
      if (f.optional) continue;
      throw new Error(`${c.name}: ${f.label} is required`);
    }
    if (f.pattern && !f.pattern.test(raw)) throw new Error(`${c.name}: that doesn't look like a ${f.label}`);
    v[f.key] = raw;
  }
  if (id === "stripe" && /^sk_/.test(String(values.key ?? ""))) throw new Error("Stripe: use a restricted key (rk_), never a full secret key");
  const ro = readOnly ?? c.readOnly?.default ?? true;
  return { server: serverName(id), config: c.build(v, { readOnly: ro }), readOnly: ro, values: v };
}

// Split values into what goes to the keychain and what is plain settings.
export function splitValues(id, values) {
  const c = byId(id);
  const secret = {};
  const plain = {};
  for (const f of c?.fields ?? []) {
    if (values[f.key] == null || values[f.key] === "") continue;
    (f.secret ? secret : plain)[f.key] = values[f.key];
  }
  return { secret, plain };
}

export function connectorsPath() {
  return process.env.JARVIS_CONNECTORS_FILE ?? path.join(os.homedir(), ".config", "jarvis", "connectors.json");
}

export function loadConnectors(file = connectorsPath()) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch { return {}; }
}

export function saveConnectors(data, file = connectorsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Catalog joined with what Jarvis has saved and what the server reports.
// Other MCP servers you configured yourself (e.g. aws-mcp) are listed as
// "yours" so the brain knows they exist, and are never touched.
export function connectorView(saved, servers) {
  const status = new Map((servers ?? []).map((s) => [s.name, s.status ?? {}]));
  const rows = CATALOG.map((c) => {
    const s = saved[c.id];
    const st = status.get(serverName(c.id));
    return {
      id: c.id,
      name: c.name,
      purpose: c.purpose,
      auth: c.auth,
      verified: c.verified,
      readOnlyNote: c.readOnly?.note ?? "",
      fields: c.fields.map(({ key, label, secret, optional, help }) => ({ key, label, secret: !!secret, optional: !!optional, help: help ?? "" })),
      configured: !!s,
      enabled: !!s?.enabled,
      readOnly: s?.readOnly ?? c.readOnly?.default ?? true,
      status: st?.status ?? (s?.enabled ? "pending" : "off"),
      error: st?.error ?? null,
    };
  });
  const ours = new Set(CATALOG.map((c) => serverName(c.id)));
  const yours = (servers ?? []).filter((s) => !ours.has(s.name)).map((s) => ({ id: s.name, name: s.name, status: s.status?.status ?? "unknown", yours: true }));
  return { rows, yours };
}

// For the brain's state block and the brief.
export function connectorsSummary(view) {
  const on = view.rows.filter((r) => r.enabled && r.status === "connected");
  const pending = view.rows.filter((r) => r.enabled && r.status !== "connected");
  const parts = [];
  if (on.length) parts.push(`connected: ${on.map((r) => `${r.name}${r.readOnly ? " (read-only)" : ""}`).join(", ")}`);
  if (pending.length) parts.push(`not ready: ${pending.map((r) => `${r.name} (${r.status}${r.error ? `: ${r.error}` : ""})`).join(", ")}`);
  if (view.yours.length) parts.push(`your own MCP servers: ${view.yours.map((y) => `${y.name} (${y.status})`).join(", ")}`);
  const avail = view.rows.filter((r) => !r.configured).map((r) => r.name);
  if (avail.length) parts.push(`available to set up: ${avail.join(", ")}`);
  return `Connectors — ${parts.join("; ") || "none"}.`;
}

export function briefConnectorLine(view) {
  const on = view.rows.filter((r) => r.enabled && r.status === "connected");
  if (!on.length) return "";
  return `Connected systems to check with your read-only tools: ${on.map((r) => `${r.name} (${byId(r.id).briefHint})`).join("; ")}.`;
}
