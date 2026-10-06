import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDispatches, stripDispatches, fencedFilter, buildThinkPrompt } from "../../apps/main/src/brain/brain.js";

const fence = (obj) => "```dispatch " + JSON.stringify(obj) + "```";

test("parseDispatches: accepts task with optional agent", () => {
  const reply = `On it.\n${fence({ task: "run the tests" })}\n${fence({ task: "review auth", agent: "Reviewer" })}`;
  const { dispatches, warnings } = parseDispatches(reply);
  assert.deepEqual(dispatches, [
    { task: "run the tests", agent: null },
    { task: "review auth", agent: "reviewer" },
  ]);
  assert.deepEqual(warnings, []);
});

test("parseDispatches: malformed JSON warns, never executes", () => {
  const { dispatches, warnings } = parseDispatches("```dispatch {task: nope}```");
  assert.equal(dispatches.length, 0);
  assert.match(warnings[0], /malformed/);
});

test("parseDispatches: rejects extra keys, bad agent ids, empty and oversized tasks", () => {
  const bad = [
    fence({ task: "x", agent: "a", shell: "rm -rf /" }),
    fence({ task: "x", agent: "../etc" }),
    fence({ task: "   " }),
    fence({ task: "y".repeat(2001) }),
  ].join("\n");
  const { dispatches, warnings } = parseDispatches(bad);
  assert.equal(dispatches.length, 0);
  assert.equal(warnings.length, 4);
});

test("parseDispatches: fences must be on their own line", () => {
  const { dispatches } = parseDispatches(`text ${fence({ task: "inline" })}`);
  assert.equal(dispatches.length, 0);
});

test("parseDispatches: tolerates null and empty input", () => {
  assert.deepEqual(parseDispatches(null), { dispatches: [], warnings: [] });
  assert.deepEqual(parseDispatches(""), { dispatches: [], warnings: [] });
});

test("stripDispatches: removes fence lines and collapses blank runs", () => {
  const out = stripDispatches(`Sure.\n\n${fence({ task: "a" })}\n\n\n${fence({ task: "b" })}\nDone.`);
  assert.equal(out, "Sure.\n\nDone.");
});

test("fencedFilter: holds fence lines and partial lines, flushes tail", () => {
  const seen = [];
  const f = fencedFilter((d) => seen.push(d));
  f.push("Hel");
  f.push("lo\n```dispatch {\"task\":");
  f.push(" \"x\"}```\nbye");
  assert.deepEqual(seen, ["Hello\n"]);
  f.flush();
  assert.deepEqual(seen, ["Hello\n", "bye"]);
});

test("fencedFilter: flush drops a trailing fence", () => {
  const seen = [];
  const f = fencedFilter((d) => seen.push(d));
  f.push(fence({ task: "x" }));
  f.flush();
  assert.deepEqual(seen, []);
});

test("buildThinkPrompt: forbids fences with an empty fleet", () => {
  assert.match(buildThinkPrompt("hi", [], []), /do not emit dispatch fences/);
});

test("buildThinkPrompt: lists memories and fleet agents", () => {
  const p = buildThinkPrompt("review it", ["user prefers vim"], [{ id: "reviewer", description: "Reviews code" }]);
  assert.match(p, /user prefers vim/);
  assert.match(p, /reviewer \(Reviews code\)/);
  assert.match(p, /User: review it$/);
});
