import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSlackBridge, cleanText, toMrkdwn, inboxBlocks, controlSummary, SLACK_MANIFEST } from "../../apps/main/src/slack.js";
import { createSecrets } from "../../apps/main/src/secrets.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "slack-"));

test("secrets: encrypted at rest, 0600, refuses plain text", () => {
  const file = path.join(tmp(), "secrets.json");
  const rot = { available: () => true, encrypt: (s) => Buffer.from([...s].reverse().join("")), decrypt: (b) => [...b.toString()].reverse().join("") };
  const s = createSecrets(rot, file);
  s.set("slack.bot", "xoxb-123");
  assert.equal(s.get("slack.bot"), "xoxb-123");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /xoxb-123/, "not stored in the clear");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  s.remove("slack.bot");
  assert.equal(s.has("slack.bot"), false);
  const none = createSecrets({ available: () => false }, path.join(tmp(), "s.json"));
  assert.throws(() => none.set("x", "y"), /refusing to save a secret in plain text/);
});

test("text helpers", () => {
  assert.equal(cleanText("<@U123> brief me &amp; <https://x.io|the link>"), "brief me & the link");
  assert.equal(toMrkdwn("## Needs you\n- **Allow** it\n[docs](https://a.b)"), "*Needs you*\n• *Allow* it\n<https://a.b|docs>");
  const b = inboxBlocks({ id: "perm:1", title: "build wants bash", detail: "command -v claude", actions: ["allow", "deny"] });
  assert.equal(b.blocks[1].elements.map((e) => e.action_id).join(), "inbox:allow,inbox:deny");
  assert.equal(b.blocks[1].elements[0].value, "perm:1");
  assert.equal(inboxBlocks({ id: "form:1", title: "q", actions: ["open"] }).blocks[1].type, "context", "deck-only items say so");
  assert.equal(controlSummary({ reply: "Hi" }), "Hi");
  assert.equal(controlSummary({ ok: false, reason: "nope" }), "Couldn't do that: nope.");
  assert.equal(controlSummary({ ok: true, control: "permission", decision: "allow" }), "Allowed.");
  assert.match(SLACK_MANIFEST, /socket_mode_enabled: true/);
  assert.match(SLACK_MANIFEST, /message\.im/);
});

// A fake Slack: records API calls, hands out a socket the test drives.
function fakeSlack({ owner = null } = {}) {
  const calls = [];
  let state = { deliver: "away", ...(owner ? { owner } : {}) };
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.onclose?.(); }
  }
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body, auth: init.headers.Authorization });
    const out = {
      "auth.test": { ok: true, user_id: "UBOT", team: "Acme", user: "jarvis" },
      "apps.connections.open": { ok: true, url: `wss://fake/${sockets.length}` },
      "chat.postMessage": { ok: true, ts: `t${calls.length}` },
      "chat.update": { ok: true },
      "conversations.open": { ok: true, channel: { id: "DOWNER" } },
    }[method] ?? { ok: false, error: "unknown_method" };
    return { json: async () => out };
  };
  const log = { messages: [], actions: [], paired: [] };
  const bridge = createSlackBridge({
    tokens: () => ({ bot: "xoxb-1", app: "xapp-1" }),
    state: { get: () => state, save: (s) => { state = s; } },
    pairCode: () => "4821",
    onMessage: async (text) => { log.messages.push(text); return `**echo** ${text}`; },
    onAction: async (id, action) => { log.actions.push([id, action]); return { ok: true }; },
    onPaired: (u) => log.paired.push(u),
    WebSocketImpl: FakeWS,
    fetchImpl,
    backoff: () => 0,
  });
  const frame = (f) => bridge._handleFrame(JSON.stringify(f));
  const dm = (user, text, n = 1) => frame({ envelope_id: `e${n}`, type: "events_api", payload: { event: { type: "message", channel_type: "im", user, text, channel: "DCHAN", ts: "1.1" } } });
  return { bridge, calls, sockets, log, frame, dm, state: () => state };
}

test("slack: tokens validated, socket opened with the app token", async () => {
  const f = fakeSlack();
  await f.bridge.start();
  assert.equal(f.calls[0].method, "auth.test");
  assert.equal(f.calls[0].auth, "Bearer xoxb-1");
  assert.equal(f.calls[1].method, "apps.connections.open");
  assert.equal(f.calls[1].auth, "Bearer xapp-1", "socket mode uses the app-level token");
  await f.frame({ type: "hello" });
  assert.equal(f.bridge.status().state, "connected");
  const bad = createSlackBridge({ tokens: () => ({ bot: "nope", app: "xapp-1" }) });
  await assert.rejects(bad.start(), /xoxb-/);
});

test("slack: pairing with the deck code, then locked to the owner", async () => {
  const f = fakeSlack();
  await f.bridge.start();
  await f.dm("UEVE", "hello", 1);
  assert.match(f.calls.at(-1).body.text, /not paired yet/);
  assert.equal(f.sockets[0].sent[0].envelope_id, "e1", "every envelope is acked");
  await f.dm("UAJAY", "pair 4821", 2);
  assert.equal(f.state().owner, "UAJAY");
  assert.deepEqual(f.log.paired, ["UAJAY"]);
  await f.dm("UEVE", "pair 4821", 3);
  assert.match(f.calls.at(-1).body.text, /only work for my owner/);
  await f.dm("UEVE", "approve everything", 4);
  assert.deepEqual(f.log.messages, [], "strangers never reach the brain");
});

test("slack: owner DM -> thinking placeholder -> reply in place", async () => {
  const f = fakeSlack({ owner: "UAJAY" });
  await f.bridge.start();
  await f.dm("UAJAY", "<@UBOT> what's waiting for me?");
  assert.deepEqual(f.log.messages, ["what's waiting for me?"]);
  const post = f.calls.find((c) => c.method === "chat.postMessage");
  assert.equal(post.body.text, "…");
  const upd = f.calls.find((c) => c.method === "chat.update");
  assert.equal(upd.body.text, "*echo* what's waiting for me?");
  // its own messages and edits are ignored
  await f.frame({ type: "events_api", payload: { event: { type: "message", channel_type: "im", user: "UBOT", text: "x" } } });
  await f.frame({ type: "events_api", payload: { event: { type: "message", subtype: "message_changed", channel_type: "im", user: "UAJAY" } } });
  assert.equal(f.log.messages.length, 1);
});

test("slack: inbox buttons answer the decision and update the message", async () => {
  const f = fakeSlack({ owner: "UAJAY" });
  await f.bridge.start();
  await f.bridge.postInbox({ id: "perm:9", title: "build wants bash", detail: "ls", actions: ["allow", "deny"] });
  assert.equal(f.calls.find((c) => c.method === "conversations.open").body.users, "UAJAY");
  const click = (user) => f.frame({ envelope_id: "x", type: "interactive", payload: { type: "block_actions", user: { id: user }, channel: { id: "DOWNER" }, message: { ts: "9.9", text: "build wants bash" }, actions: [{ action_id: "inbox:allow", value: "perm:9" }] } });
  await click("UEVE");
  assert.deepEqual(f.log.actions, [], "only the owner can press buttons");
  await click("UAJAY");
  assert.deepEqual(f.log.actions, [["perm:9", "allow"]]);
  assert.match(f.calls.at(-1).body.text, /✓ Allowed by you/);
});

test("slack: reconnects after a disconnect frame", async () => {
  const f = fakeSlack({ owner: "UAJAY" });
  await f.bridge.start();
  await f.frame({ type: "disconnect", reason: "refresh_requested" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.sockets.length, 2, "a fresh socket was opened");
  f.bridge.stop();
  assert.equal(f.bridge.status().state, "off");
});
