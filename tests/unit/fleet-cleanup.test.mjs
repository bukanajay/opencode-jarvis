import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFleetCommand, cleanupTargets, routeUtterance } from "../../apps/main/src/fleet.js";
import { stripDispatches, buildThinkPrompt, fencedFilter } from "../../apps/main/src/brain/brain.js";
import { parseJarvisActions, validateAction, resolveRef, stateBlock, SETTABLE } from "../../apps/main/src/actions.js";

test("matchFleetCommand: the user's own phrasings", () => {
  assert.deepEqual(matchFleetCommand("Clean up the completed or failed workers."), { states: ["done", "failed"] });
  assert.deepEqual(matchFleetCommand("cleanup completed and failed workers"), { states: ["done", "failed"] });
  assert.deepEqual(matchFleetCommand("remove the failed agents"), { states: ["failed"] });
  assert.deepEqual(matchFleetCommand("clear the finished workers"), { states: ["done", "failed", "stopped"] });
  assert.deepEqual(matchFleetCommand("clean up the fleet"), { states: ["done", "failed", "stopped"] });
  assert.deepEqual(matchFleetCommand("delete all stopped sessions"), { states: ["stopped"] });
  assert.equal(matchFleetCommand("remove the running workers"), null, "never kills live work by phrase");
  assert.equal(matchFleetCommand("clean up the parser module"), null);
  assert.equal(routeUtterance("Clean up the completed or failed workers.", false, false).route, "fleet.cleanup");
});

test("cleanupTargets: only finished workers in this project", () => {
  const list = [
    { sessionID: "a", state: "done", project: "/p" },
    { sessionID: "b", state: "failed", project: "/p" },
    { sessionID: "c", state: "working", project: "/p" },
    { sessionID: "d", state: "permission", project: "/p" },
    { sessionID: "e", state: "done", project: "/other" },
    { sessionID: "f", state: "stopped", project: "/p" },
  ];
  assert.deepEqual(cleanupTargets(list, ["done", "failed"], "/p"), ["a", "b"]);
  assert.deepEqual(cleanupTargets(list, ["done", "failed", "stopped", "working"], "/p"), ["a", "b", "f"], "working is never a cleanup state");
});

test("jarvis actions: parsed, validated, hidden from the transcript", () => {
  const reply = 'Clearing them now.\n```jarvis {"action": "cleanup", "states": ["done", "failed"]}```';
  assert.deepEqual(parseJarvisActions(reply).actions, [{ action: "cleanup", states: ["done", "failed"] }]);
  assert.equal(stripDispatches(reply), "Clearing them now.");
  const seen = [];
  const f = fencedFilter((d) => seen.push(d));
  f.push(reply + "\n");
  f.flush();
  assert.deepEqual(seen, ["Clearing them now.\n"], "never streamed to the deck");
  const bad = parseJarvisActions([
    '```jarvis {"action": "cleanup", "states": ["working"]}```',
    '```jarvis {"action": "allow", "request": "x"}```',
    '```jarvis {"action": "set", "setting": "onboarded", "value": "off"}```',
    '```jarvis {"action": "stop", "worker": "../../etc"}```',
    '```jarvis {"action": "set", "setting": "voice", "value": "bm_lewis", "extra": 1}```',
  ].join("\n"));
  assert.deepEqual(bad.actions, []);
  assert.equal(bad.warnings.length, 5);
});

test("validateAction: the allowlist", () => {
  assert.deepEqual(validateAction({ action: "set", setting: "voice", value: "bm_lewis" }), { action: "set", setting: "voice", value: "bm_lewis" });
  assert.deepEqual(validateAction({ action: "cleanup" }), { action: "cleanup", states: ["done", "failed", "stopped"] });
  assert.deepEqual(validateAction({ action: "followup", worker: "ses_ed99d5c9", task: "also run the tests" }), { action: "followup", worker: "ses_ed99d5c9", task: "also run the tests" });
  assert.deepEqual(validateAction({ action: "land" }), { action: "land" });
  assert.deepEqual(validateAction({ action: "project", name: "opencode-jarvis" }), { action: "project", name: "opencode-jarvis" });
  assert.throws(() => validateAction({ action: "followup", worker: "ses_1234", task: "a\nb" }), /bad task/);
  assert.ok(!SETTABLE.includes("onboarded") && !SETTABLE.includes("audioDevice"));
});

test("resolveRef: short ids from the state block", () => {
  const ids = ["ses_ed99d5c93ffej34", "ses_ed99cbbf3ffevdh", "ses_ab12"];
  assert.equal(resolveRef("ses_ed99d5c9", ids), "ses_ed99d5c93ffej34");
  assert.equal(resolveRef("ses_ed99", ids), null, "ambiguous");
  assert.equal(resolveRef("ses_zz", ids), null);
});

test("stateBlock: what the brain sees", () => {
  const block = stateBlock({
    workers: [{ sessionID: "ses_ed99d5c93ffej34", agent: "build", state: "failed", task: "Check git status" }],
    chains: [{ chainID: "ses_ed99d5c93ffej34", branch: "jarvis/check-git", state: "open" }],
    settings: { jarvisModel: "opencode-go/gpt-6-luna", workerModel: "opencode-go/muse", voice: "bm_george" },
    projects: [{ name: "opencode-jarvis", dir: "/x" }],
    pendingPermissions: 1,
  });
  assert.match(block, /ses_ed99d5c9 build failed: Check git status/);
  assert.match(block, /jarvis\/check-git/);
  assert.match(block, /only the user may answer/);
  assert.match(block, /Recent projects: opencode-jarvis/);
  assert.match(stateBlock({}), /Workers: none/);
});

test("brain prompt: knows its own actions and the deck state, never talks about modes", () => {
  const p = buildThinkPrompt("clean up", [], [], null, { context: "Workers: none." });
  assert.match(p, /```jarvis \{"action"/);
  assert.match(p, /Right now:\nWorkers: none\./);
  assert.match(p, /never ask the user to switch modes/);
  assert.match(p, /never answer a worker's permission request/);
});

test("normalizeValue: what models actually send", () => {
  assert.deepEqual(validateAction({ action: "set", setting: "voice", value: "Michael" }), { action: "set", setting: "voice", value: "am_michael" });
  assert.deepEqual(validateAction({ action: "set", setting: "followUp", value: 60 }), { action: "set", setting: "followUp", value: "60" });
  assert.equal(validateAction({ action: "set", setting: "followUp", value: "2 minutes" }).value, "120");
  assert.equal(validateAction({ action: "set", setting: "voiceMode", value: true }).value, "on");
  assert.equal(validateAction({ action: "set", setting: "accent", value: "Amber" }).value, "amber");
  assert.equal(validateAction({ action: "set", setting: "voice", value: "Robot" }).value, "Robot", "left for the shell validator to reject");
});

import { matchFacts } from "../../apps/main/src/brain/memory.js";
import { startCreateWithPurpose } from "../../apps/main/src/bootstrap.js";

test("remember / forget / agent actions validate", () => {
  assert.deepEqual(validateAction({ action: "remember", fact: "Ajay prefers short answers" }), { action: "remember", fact: "Ajay prefers short answers", scope: "user" });
  assert.deepEqual(validateAction({ action: "forget", fact: "tabs", scope: "project" }), { action: "forget", fact: "tabs", scope: "project" });
  assert.throws(() => validateAction({ action: "remember", fact: "x", scope: "everyone" }), /scope/);
  assert.deepEqual(validateAction({ action: "agent", purpose: "reviews SQL migrations" }), { action: "agent", purpose: "reviews SQL migrations" });
});

test("matchFacts: exact, containment, overlap, ambiguity", () => {
  const mem = { facts: [
    { id: "1", text: "Ajay prefers tabs over spaces" },
    { id: "2", text: "The staging database is on RDS" },
    { id: "3", text: "Deploys happen on Fridays" },
  ] };
  assert.deepEqual(matchFacts(mem, "the staging database is on rds").map((f) => f.id), ["2"]);
  assert.deepEqual(matchFacts(mem, "tabs over spaces").map((f) => f.id), ["1"]);
  assert.deepEqual(matchFacts(mem, "fridays deploys").map((f) => f.id), ["3"]);
  assert.deepEqual(matchFacts(mem, "pizza"), []);
  assert.deepEqual(matchFacts(mem, ""), []);
});

test("startCreateWithPurpose: skips straight to the provider question", async () => {
  const r = await startCreateWithPurpose("reviews SQL migrations", { providers: ["opencode-go"], modelsByProvider: {} }, []);
  assert.equal(r.stage, "provider");
  assert.equal(r.conv.name, "reviews-sql-migrations");
  assert.match(r.prompt, /opencode-go/);
  const named = await startCreateWithPurpose("Review SQL migrations before they ship, checking safety and rollback.", { providers: ["opencode-go"] }, [], "sql-reviewer");
  assert.equal(named.conv.name, "sql-reviewer");
  assert.match(named.prompt, /should sql-reviewer use/);
  assert.throws(() => validateAction({ action: "agent", purpose: "x y", name: "Not Kebab!" }), /kebab/);
});
