import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { workers, handleFleetEvent, reconcileWorkers, snapshot } from "../../apps/main/src/fleet.js";
import { fakeClient } from "../helpers/fake-client.mjs";

function seed(id, extra = {}) {
  workers.set(id, { sessionID: id, task: "t", state: "working", tools: [], transcript: "", reasoning: "", pending: null, model: null, chain: id, round: 0, agent: "build", promptedAt: Date.now() - 1000, ...extra });
}

beforeEach(() => workers.clear());

test("handleFleetEvent: ignores sessions that are not workers", () => {
  const out = [];
  handleFleetEvent({ type: "session.execution.succeeded", data: { sessionID: "brain" } }, (m) => out.push(m));
  assert.deepEqual(out, []);
});

test("handleFleetEvent: one worker.done per run, carrying chain info", () => {
  seed("w1", { round: 2, chain: "root" });
  const out = [];
  const emit = (m) => out.push(m);
  handleFleetEvent({ type: "session.execution.succeeded", data: { sessionID: "w1" } }, emit);
  handleFleetEvent({ type: "session.execution.succeeded", data: { sessionID: "w1" } }, emit);
  const done = out.filter((m) => m.kind === "worker.done");
  assert.equal(done.length, 1);
  assert.deepEqual({ ...done[0] }, { kind: "worker.done", sessionID: "w1", status: "ok", error: null, round: 2, chain: "root", agent: "build", review: true });
  assert.equal(workers.get("w1").state, "done");
});

test("handleFleetEvent: interrupted runs are never reviewed", () => {
  seed("w1");
  const out = [];
  handleFleetEvent({ type: "session.execution.interrupted", data: { sessionID: "w1" } }, (m) => out.push(m));
  assert.equal(out[0].review, false);
  assert.equal(workers.get("w1").state, "stopped");
});

test("handleFleetEvent: text deltas accumulate and stream", () => {
  seed("w1");
  const out = [];
  handleFleetEvent({ type: "session.text.delta", data: { sessionID: "w1", delta: { text: "hi" } } }, (m) => out.push(m));
  assert.equal(workers.get("w1").transcript, "hi");
  assert.equal(out[0].kind, "worker.stream");
  assert.equal(snapshot()[0].round, 0);
});

test("reconcileWorkers: reports runs that finished during a stream gap", async () => {
  const now = Date.now();
  seed("finished");
  seed("still", {});
  seed("old-outcome", { promptedAt: now });
  const { client } = fakeClient();
  client.session.get = async ({ sessionID }) => ({
    finished: { outcome: "succeeded", time: { idle: now } },
    still: { time: {} },
    "old-outcome": { outcome: "succeeded", time: { idle: now - 5000 } },
  })[sessionID];
  const out = [];
  await reconcileWorkers(client, (m) => out.push(m));
  assert.deepEqual(out.map((m) => m.sessionID), ["finished"]);
  assert.equal(workers.get("still").state, "working");
});
