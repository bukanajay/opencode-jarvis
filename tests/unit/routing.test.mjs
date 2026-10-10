import { test } from "node:test";
import assert from "node:assert/strict";
import { routeUtterance } from "../../apps/main/src/fleet.js";
import { matchAppCommand } from "../../apps/main/src/shell.js";
import { matchConfigCommand, isWidening } from "../../apps/main/src/config.js";
import { matchFormAnswer } from "../../apps/main/src/forms.js";
import { parseModelRef } from "../../apps/main/src/sessions.js";

test("routeUtterance: permission answers only when one is pending", () => {
  assert.deepEqual(routeUtterance("allow", true, false), { route: "permission", decision: "allow" });
  assert.deepEqual(routeUtterance("Deny", true, false), { route: "permission", decision: "deny" });
  assert.equal(routeUtterance("allow", false, false).route, "prompt");
});

test("routeUtterance: config confirm only when a widening change is staged", () => {
  assert.deepEqual(routeUtterance("yes, apply it", false, true), { route: "config.confirm", confirmed: true });
  assert.deepEqual(routeUtterance("cancel", false, true), { route: "config.confirm", confirmed: false });
  assert.equal(routeUtterance("cancel", false, false).route, "prompt");
});

test("routeUtterance: form answers win over config confirms", () => {
  assert.equal(routeUtterance("yes", false, true, { choice: "yes" }).route, "form.answer");
});

test("routeUtterance: shell, config and worker controls", () => {
  assert.equal(routeUtterance("dim the fleet", false, false).route, "app.command");
  assert.equal(routeUtterance("add a reviewer", false, false).route, "config.apply");
  assert.equal(routeUtterance("delete the worker", false, false).route, "config.stage");
  assert.equal(routeUtterance("stop the worker", false, false).route, "stop-worker");
  assert.equal(routeUtterance("refactor the parser", false, false).route, "prompt");
});

test("matchAppCommand: theme is an alias of accent", () => {
  assert.deepEqual(matchAppCommand("set the theme to amber"), { name: "set.accent", args: { value: "amber" } });
  assert.deepEqual(matchAppCommand("turn voice mode on"), { name: "set.voiceMode", args: { value: "on" } });
  assert.equal(matchAppCommand("set the theme to purple"), null);
});

test("matchConfigCommand: widening is flagged", () => {
  assert.equal(isWidening(matchConfigCommand("add a read-only reviewer")), false);
  assert.equal(isWidening(matchConfigCommand("let every agent run any shell command")), true);
  assert.equal(matchConfigCommand("add a reviewer please"), null);
});

test("matchFormAnswer: single option field only", () => {
  const form = { fields: [{ key: "pick", options: [{ value: "red" }, { value: "blue" }] }] };
  assert.deepEqual(matchFormAnswer(form, "Blue"), { pick: "blue" });
  assert.deepEqual(matchFormAnswer(form, "the red one"), { pick: "red" });
  assert.equal(matchFormAnswer(form, "green"), null);
  assert.equal(matchFormAnswer({ fields: [form.fields[0], form.fields[0]] }, "red"), null);
});

test("parseModelRef: provider/id with slashes in the id", () => {
  assert.deepEqual(parseModelRef("openrouter/meta/llama"), { providerID: "openrouter", id: "meta/llama" });
  assert.equal(parseModelRef("nope"), null);
  assert.equal(parseModelRef(null), null);
});

test("routeUtterance: land / keep / discard chain controls", () => {
  assert.deepEqual(routeUtterance("land it", false, false), { route: "chain.action", action: "land" });
  assert.deepEqual(routeUtterance("merge the changes", false, false), { route: "chain.action", action: "land" });
  assert.deepEqual(routeUtterance("keep the branch", false, false), { route: "chain.action", action: "keep" });
  assert.deepEqual(routeUtterance("Discard", false, false), { route: "chain.action", action: "discard" });
  assert.equal(routeUtterance("discard the old parser code", false, false).route, "prompt");
});

test("matchAppCommand: isolation and review mode", () => {
  assert.deepEqual(matchAppCommand("work in my checkout"), { name: "set.isolation", args: { value: "shared" } });
  assert.deepEqual(matchAppCommand("set isolation to worktree"), { name: "set.isolation", args: { value: "worktree" } });
  assert.deepEqual(matchAppCommand("turn review mode off"), { name: "set.reviewMode", args: { value: "off" } });
});

test("routeUtterance: spoken punctuation does not break local commands", () => {
  assert.equal(routeUtterance("Use the amber accent.", false, false).name, "set.accent");
  assert.deepEqual(routeUtterance("Allow.", true, false), { route: "permission", decision: "allow" });
  assert.deepEqual(routeUtterance("No!", true, false), { route: "permission", decision: "deny" });
  assert.equal(routeUtterance("Stop the worker.", false, false).route, "stop-worker");
  assert.equal(routeUtterance("Why is the build failing?", false, false).route, "prompt");
});
