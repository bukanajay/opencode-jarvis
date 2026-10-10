import { test } from "node:test";
import assert from "node:assert/strict";
import { routeUtterance } from "../../apps/main/src/fleet.js";
import { permissionLine } from "../../apps/main/src/speech.js";
import { nextVoiceAction } from "../../apps/main/src/voice.js";
import { needsWorkerFallback, buildThinkPrompt } from "../../apps/main/src/brain/brain.js";

test("needsWorkerFallback: brain refusing for lack of shell becomes a worker task", () => {
  // Real replies from the brain session that dropped "is Claude installed?".
  assert.ok(needsWorkerFallback("I can’t inspect system-wide installs from this read-only project session. To check locally, run `command -v claude`."));
  assert.ok(needsWorkerFallback("Thanks, Ajay. Permission isn't the blocker—this session has no access to your Mac's shell, so I still can't run the check."));
  assert.ok(needsWorkerFallback("I can't run commands here. Try `which claude` in your terminal."));
  assert.ok(!needsWorkerFallback("I can't run commands here.", [{ task: "check" }]), "already delegated");
  assert.ok(!needsWorkerFallback("The parser lives in brain.js and drops extra keys."));
  assert.ok(!needsWorkerFallback("There's no shellcheck config in the repo, so lint rules are defaults."), "not a refusal");
});

test("brain prompt: machine checks are delegated, never pushed back to the user", () => {
  const p = buildThinkPrompt("is claude installed?", [], [{ id: "build" }]);
  assert.match(p, /is a tool installed/);
  assert.match(p, /Never tell the user to run a command themselves/);
});

test("spoken permission answers", () => {
  for (const t of ["yes", "Yes, go ahead.", "allow once", "okay do it", "sure", "go ahead", "yeah run it"]) {
    assert.deepEqual(routeUtterance(t, true, false), { route: "permission", decision: "allow" }, t);
  }
  for (const t of ["no", "No, don't.", "deny", "nope", "cancel", "don't do it"]) {
    assert.deepEqual(routeUtterance(t, true, false), { route: "permission", decision: "deny" }, t);
  }
  assert.equal(routeUtterance("yes", false, false).route, "prompt", "no pending request: just conversation");
  assert.equal(routeUtterance("yes but first show me the diff", true, false).route, "prompt");
});

test("permissionLine: says who wants what", () => {
  assert.equal(permissionLine({ action: "bash", resources: ["command -v claude"] }, "build"), "The build worker wants to run command -v claude. Allow it?");
  assert.equal(permissionLine({ action: "edit", resources: ["apps/main/src/x.js"] }), "A worker wants to edit apps/main/src/x.js. Allow it?");
  assert.match(permissionLine({ action: "bash", resources: ["x".repeat(200)] }), /…\. Allow it\?$/);
  assert.equal(permissionLine({ action: "external_directory", resources: [] }), "A worker needs external_directory permission. Allow it?");
});

test("while a question is pending, okay/yes are answers, not filler", () => {
  const on = { voiceMode: "on", wakeWord: "jarvis", inConversation: true };
  assert.deepEqual(nextVoiceAction("Okay.", on), { action: "ack" });
  assert.deepEqual(nextVoiceAction("Okay.", { ...on, answering: true }), { action: "follow-up", text: "Okay." });
  assert.deepEqual(nextVoiceAction("yes", { ...on, answering: true }), { action: "follow-up", text: "yes" });
});
