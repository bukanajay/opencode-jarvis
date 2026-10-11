// Slack bridge: reach Jarvis from your phone or laptop when the deck is not
// in front of you. Socket Mode (an outbound WebSocket from this Mac), so no
// public URL or server. DMs go through the same brain/commit path as the
// deck; decisions arrive with buttons; briefs and worker results are posted
// when you are away. Locked to one owner, paired once with a code shown in
// the deck. WebSocket and fetch are injected so tests run against a fake.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SLACK_MANIFEST = `display_information:
  name: Jarvis
  description: Your chief of staff, running on your Mac
  background_color: "#0a0f12"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Jarvis
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:read
      - im:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;

export const DELIVER_MODES = ["away", "always", "off"];

export function slackStatePath() {
  return process.env.JARVIS_SLACK_FILE ?? path.join(os.homedir(), ".config", "jarvis", "slack.json");
}

export function loadSlackState(file = slackStatePath()) {
  try { return { deliver: "away", ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return { deliver: "away" }; }
}

export function saveSlackState(state, file = slackStatePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// Slack text in: mentions and link markup out, entities decoded.
export function cleanText(t) {
  return String(t ?? "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Markdown out -> Slack mrkdwn (bold, headings, links, bullets).
export function toMrkdwn(md) {
  return String(md ?? "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .trim();
}

const BTN = {
  allow: ["Allow", "primary"], deny: ["Deny", "danger"], confirm: ["Confirm", "primary"], cancel: ["Cancel", "danger"],
  land: ["Land", "primary"], keep: ["Keep branch", null], discard: ["Discard", "danger"],
  always: ["Always allow", "primary"], dismiss: ["Not now", null],
};
const DONE = { allow: "Allowed", deny: "Denied", confirm: "Confirmed", cancel: "Cancelled", land: "Landed", keep: "Kept", discard: "Discarded", always: "Rule added", dismiss: "Dismissed" };

export function inboxBlocks(item) {
  const head = `*${item.title}*${item.detail ? `\n\`${String(item.detail).replace(/`/g, "'")}\`` : ""}`;
  const buttons = item.actions.filter((a) => BTN[a]).map((a) => {
    const [text, style] = BTN[a];
    return { type: "button", text: { type: "plain_text", text }, action_id: `inbox:${a}`, value: item.id, ...(style ? { style } : {}) };
  });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: head } }];
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  else blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Answer this one in the Jarvis deck." }] });
  return { text: item.title, blocks };
}

// What to send back for a deck control (commitText result without a reply).
export function controlSummary(r) {
  if (!r) return "Done.";
  if (r.reply) return r.reply;
  if (r.ok === false) return `Couldn't do that: ${r.reason ?? "unknown error"}.`;
  switch (r.control) {
    case "app.command": return `Done: ${r.entry?.what ?? "setting applied"}.`;
    case "permission": return `${r.decision === "allow" ? "Allowed" : "Denied"}.`;
    case "fleet.cleanup": return r.line ?? "Cleaned up.";
    case "standdown": return r.line ?? "Standing down.";
    case "stop-worker": return "Stopped the worker.";
    case "brief": return "Brief posted.";
    default: return r.line ?? "Done.";
  }
}

export function createSlackBridge(deps) {
  const {
    tokens, // () => ({ bot, app })
    state = { get: loadSlackState, save: saveSlackState },
    pairCode, // () => current pairing code (string)
    onMessage, // async (text, meta) => reply text
    onAction, // async (inboxItemId, action) => { ok, reason? }
    onPaired = () => {}, // (owner) => void
    onStatus = () => {}, // (status) => void
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
    log = () => {},
    backoff = (n) => Math.min(60000, 1000 * 2 ** n),
  } = deps;

  let ws = null;
  let stopped = true;
  let attempts = 0;
  let status = { state: "off" };
  let botUserId = null;
  const warned = new Set();

  const setStatus = (s) => { status = { ...status, ...s }; onStatus(status); };

  async function api(method, body = {}, token = tokens().bot) {
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.error ?? "failed"}`);
    return json;
  }

  async function dmChannel() {
    const s = state.get();
    if (!s.owner) return null;
    if (s.channel) return s.channel;
    const r = await api("conversations.open", { users: s.owner });
    state.save({ ...s, channel: r.channel.id });
    return r.channel.id;
  }

  async function post(text, extra = {}) {
    const channel = extra.channel ?? (await dmChannel());
    if (!channel) return null;
    return api("chat.postMessage", { channel, text: toMrkdwn(text), unfurl_links: false, ...extra });
  }

  async function handleEvent(e) {
    if (!e || e.type !== "message" || e.channel_type !== "im" || e.bot_id || e.subtype || e.user === botUserId) return;
    const text = cleanText(e.text);
    const s = state.get();
    if (!s.owner) {
      const code = pairCode?.();
      if (code && text.replace(/\s+/g, " ").toLowerCase() === `pair ${code}`.toLowerCase()) {
        state.save({ ...s, owner: e.user, channel: e.channel, pairedAt: Date.now() });
        onPaired(e.user);
        await post("Paired. I'll only listen to you here. Ask me anything you'd ask in the deck, say *brief* for your brief, or *inbox* for what's waiting.", { channel: e.channel });
      } else {
        await post("I'm not paired yet. Open the Jarvis deck → Settings → Slack and send me the pairing code shown there, like `pair 1234`.", { channel: e.channel });
      }
      return;
    }
    if (e.user !== s.owner) {
      if (!warned.has(e.user)) { warned.add(e.user); await post("I only work for my owner.", { channel: e.channel }); }
      return;
    }
    if (s.channel !== e.channel) state.save({ ...s, channel: e.channel });
    const thinking = await post("…", { channel: e.channel });
    let reply;
    try { reply = await onMessage(text, { user: e.user, channel: e.channel, ts: e.ts }); }
    catch (err) { reply = `Something failed: ${String(err.message ?? err).slice(0, 200)}`; }
    const body = toMrkdwn(reply || "Done.");
    if (thinking?.ts) await api("chat.update", { channel: e.channel, ts: thinking.ts, text: body });
    else await post(body, { channel: e.channel });
  }

  async function handleInteractive(p) {
    if (p?.type !== "block_actions") return;
    if (p.user?.id !== state.get().owner) return;
    for (const a of p.actions ?? []) {
      const [prefix, action] = String(a.action_id ?? "").split(":");
      if (prefix !== "inbox") continue;
      let r;
      try { r = await onAction(a.value, action); } catch (err) { r = { ok: false, reason: String(err.message ?? err) }; }
      const title = p.message?.text ?? "Decision";
      const outcome = r.ok ? `✓ ${DONE[action] ?? action} by you` : `✗ couldn't ${action}: ${r.reason ?? "failed"}`;
      await api("chat.update", {
        channel: p.channel?.id ?? p.container?.channel_id,
        ts: p.message?.ts ?? p.container?.message_ts,
        text: `${title} — ${outcome}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
          { type: "context", elements: [{ type: "mrkdwn", text: outcome }] },
        ],
      });
    }
  }

  async function handleFrame(raw) {
    let f;
    try { f = JSON.parse(typeof raw === "string" ? raw : String(raw)); } catch { return; }
    if (f.envelope_id) ws?.send(JSON.stringify({ envelope_id: f.envelope_id }));
    if (f.type === "hello") { attempts = 0; setStatus({ state: "connected", error: null }); return; }
    if (f.type === "disconnect") { try { ws?.close(); } catch {} return; }
    try {
      if (f.type === "events_api") await handleEvent(f.payload?.event);
      else if (f.type === "interactive") await handleInteractive(f.payload);
    } catch (err) {
      log(`slack: ${err.message ?? err}`);
    }
  }

  async function connect() {
    if (stopped) return;
    setStatus({ state: "connecting" });
    try {
      const { url } = await api("apps.connections.open", {}, tokens().app);
      const sock = new WebSocketImpl(url);
      ws = sock;
      sock.onmessage = (ev) => { handleFrame(ev.data); };
      sock.onclose = () => {
        if (ws === sock) ws = null;
        if (stopped) return;
        setStatus({ state: "connecting" });
        setTimeout(connect, backoff(attempts++));
      };
      sock.onerror = () => {};
    } catch (err) {
      setStatus({ state: "error", error: String(err.message ?? err) });
      if (!stopped && !/invalid_auth|not_authed|token_revoked|missing_scope/.test(String(err.message))) setTimeout(connect, backoff(attempts++));
    }
  }

  return {
    async start() {
      const t = tokens();
      if (!t.bot?.startsWith("xoxb-")) throw new Error("bot token should start with xoxb-");
      if (!t.app?.startsWith("xapp-")) throw new Error("app-level token should start with xapp-");
      const auth = await api("auth.test");
      botUserId = auth.user_id;
      setStatus({ team: auth.team, bot: auth.user });
      stopped = false;
      attempts = 0;
      await connect();
      return status;
    },
    stop() {
      stopped = true;
      try { ws?.close(); } catch {}
      ws = null;
      setStatus({ state: "off" });
    },
    status: () => ({ ...status, paired: !!state.get().owner }),
    post,
    postInbox: (item) => post(inboxBlocks(item).text, { blocks: inboxBlocks(item).blocks }),
    // exposed for tests
    _handleFrame: handleFrame,
  };
}
