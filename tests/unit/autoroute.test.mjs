import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExplicitAgent, pickAgent, resolveAgent } from "../../apps/main/src/autoroute.js";

test("parseExplicitAgent: supported forms", () => {
  assert.deepEqual(parseExplicitAgent("@Reviewer check auth.ts"), { agent: "reviewer", task: "check auth.ts" });
  assert.deepEqual(parseExplicitAgent("ask tester to run the suite"), { agent: "tester", task: "run the suite" });
  assert.deepEqual(parseExplicitAgent("using docs write a readme"), { agent: "docs", task: "write a readme" });
  assert.deepEqual(parseExplicitAgent("using docs to write a readme"), { agent: "docs", task: "write a readme" });
  assert.deepEqual(parseExplicitAgent("with builder fix it"), { agent: "builder", task: "fix it" });
});

test("parseExplicitAgent: plain sentences never match", () => {
  assert.equal(parseExplicitAgent("please ask reviewer to look"), null);
  assert.equal(parseExplicitAgent("email me@example.com"), null);
  assert.equal(parseExplicitAgent(""), null);
});

const registry = [
  { id: "reviewer", description: "Read-only code reviewer for correctness and security" },
  { id: "tester", description: "Writes and runs unit tests" },
];

test("pickAgent: keyword and stem overlap picks the best agent", () => {
  assert.equal(pickAgent("review the auth module", registry).agent, "reviewer");
  assert.equal(pickAgent("add tests for the parser", registry).agent, "tester");
});

test("pickAgent: no hits, ties and empty registries fall back to default", () => {
  assert.match(pickAgent("make coffee", registry, "build").reason, /^none->build/);
  assert.match(pickAgent("anything", [], "build").reason, /^empty->build/);
  const tied = pickAgent("security tests", registry, "build");
  assert.equal(tied.agent, "build");
  assert.match(tied.reason, /^tie->/);
});

test("resolveAgent: explicit ids must be known", () => {
  assert.deepEqual(resolveAgent("x", { explicit: "reviewer", registry }), { agent: "reviewer" });
  assert.deepEqual(resolveAgent("x", { explicit: "build", registry }), { agent: "build" });
  assert.match(resolveAgent("x", { explicit: "ghost", registry }).error, /unknown agent/);
});

test("resolveAgent: autoMode gates keyword routing", () => {
  assert.deepEqual(resolveAgent("review this", { registry, defaultAgent: "build" }), { agent: "build" });
  assert.equal(resolveAgent("review this", { registry, autoMode: "on" }).agent, "reviewer");
});
