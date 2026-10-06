import { test } from "node:test";
import assert from "node:assert/strict";
import { finalAssistantText, summarizeDiff, buildReport, reportHeadline, buildReviewPrompt, collectWorkerReport, MAX_ROUNDS } from "../../apps/main/src/brain/report.js";
import { decideReview, parseFollowups, stripDispatches, serialize } from "../../apps/main/src/brain/brain.js";
import { fakeClient } from "../helpers/fake-client.mjs";

const asst = (...texts) => ({ type: "assistant", content: texts.map((t) => ({ type: "text", text: t })) });

test("finalAssistantText: trailing assistant run only, text parts only", () => {
  const msgs = [
    { type: "user", text: "old" },
    asst("stale"),
    { type: "user", text: "do it" },
    { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Step one." }, { type: "tool", name: "edit" }] },
    asst("Done: tests pass."),
  ];
  assert.equal(finalAssistantText(msgs), "Step one.\n\nDone: tests pass.");
  assert.equal(finalAssistantText([]), "");
});

test("buildReport + headline: files, totals, clipping", () => {
  const w = { sessionID: "ses_abcdef123", agent: "build", task: "fix parser", round: 1, chain: "ses_root" };
  const diff = [
    { file: "a.js", status: "modified", additions: 10, deletions: 2, patch: "…" },
    { file: "b.js", status: "added", additions: 30, deletions: 0, patch: "…" },
  ];
  const r = buildReport(w, { messages: [asst("x".repeat(5000))], diff });
  assert.equal(r.chain, "ses_root");
  assert.deepEqual(r.totals, { additions: 40, deletions: 2 });
  assert.equal(r.files[0].patch, undefined);
  assert.match(r.finalText, /more chars\]$/);
  assert.equal(reportHeadline(r), "build finished · 2 files (+40 −2)");
  assert.equal(reportHeadline(buildReport(w, { status: "failed" })), "build failed · no file changes");
});

test("summarizeDiff accepts bare arrays and {data}", () => {
  const row = { file: "x", status: "deleted", additions: 0, deletions: 5 };
  assert.deepEqual(summarizeDiff([row]), summarizeDiff({ data: [row] }));
});

test("buildReviewPrompt: offers fences until the round limit", () => {
  const base = buildReport({ sessionID: "ses_1", task: "t" }, {});
  assert.match(buildReviewPrompt(base), /```followup/);
  const spent = buildReviewPrompt({ ...base, round: MAX_ROUNDS });
  assert.doesNotMatch(spent, /```followup/);
  assert.match(spent, /Do not emit any fence/);
});

const fu = (task) => "```followup " + JSON.stringify({ task }) + "```";
const di = (task, agent) => "```dispatch " + JSON.stringify(agent ? { task, agent } : { task }) + "```";

test("parseFollowups: task only, extra keys rejected", () => {
  assert.deepEqual(parseFollowups(fu("run the tests")).followups, [{ task: "run the tests" }]);
  const bad = parseFollowups('```followup {"task":"x","agent":"y"}```');
  assert.equal(bad.followups.length, 0);
  assert.match(bad.warnings[0], /extra keys/);
});

test("stripDispatches removes followup fences too", () => {
  assert.equal(stripDispatches(`Needs tests.\n${fu("add tests")}`), "Needs tests.");
});

test("decideReview: one action, followup first, none past the limit", () => {
  assert.deepEqual(decideReview("Looks good.", 0), { followup: null, dispatch: null, warnings: [] });
  assert.deepEqual(decideReview(fu("run tests"), 0).followup, { task: "run tests" });
  assert.deepEqual(decideReview(di("review it", "reviewer"), 0).dispatch, { task: "review it", agent: "reviewer" });
  const both = decideReview(`${di("a")}\n${fu("b")}`, 0);
  assert.deepEqual(both.followup, { task: "b" });
  assert.equal(both.dispatch, null);
  assert.match(both.warnings[0], /first only/);
  const spent = decideReview(fu("again"), 3, 3);
  assert.equal(spent.followup, null);
  assert.match(spent.warnings[0], /round limit/);
});

test("collectWorkerReport: reads newest-first messages, degrades on errors", async () => {
  const { client } = fakeClient({
    "message.list": () => ({ data: [asst("final"), { type: "user", text: "go" }], cursor: {} }),
    "session.diff": () => { throw new Error("no diff"); },
  });
  const r = await collectWorkerReport(client, { sessionID: "ses_1", task: "go" }, { status: "ok" });
  assert.equal(r.finalText, "final");
  assert.deepEqual(r.files, []);
});

test("serialize: brain turns never overlap and errors do not jam the queue", async () => {
  const order = [];
  const slow = serialize(async () => { order.push("a:start"); await new Promise((r) => setTimeout(r, 20)); order.push("a:end"); });
  const boom = serialize(async () => { order.push("b"); throw new Error("x"); });
  const fast = serialize(async () => { order.push("c"); return 7; });
  await slow;
  await assert.rejects(boom, /x/);
  assert.equal(await fast, 7);
  assert.deepEqual(order, ["a:start", "a:end", "b", "c"]);
});
