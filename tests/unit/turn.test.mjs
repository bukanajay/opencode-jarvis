import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, READONLY_PERMISSIONS, isQuotaError } from "../../apps/main/src/turn.js";
import { fakeClient } from "../helpers/fake-client.mjs";

const later = (fn) => setImmediate(fn);

test("runTurn: streams deltas for its session only and settles ok", async () => {
  const { client, calls } = fakeClient({
    "session.prompt": ({ sessionID }, { emit }) => later(() => {
      emit("session.text.delta", { sessionID: "other", delta: "nope" });
      emit("session.text.delta", { sessionID, delta: "Hel" });
      emit("session.text.delta", { sessionID, delta: { text: "lo" } });
      emit("session.execution.succeeded", { sessionID });
    }),
  });
  const chunks = [];
  const r = await runTurn("s1", "hi", { client, onDelta: (c) => chunks.push(c) });
  assert.deepEqual(r, { status: "ok", text: "Hello" });
  assert.deepEqual(chunks, ["Hel", "lo"]);
  assert.deepEqual(calls[0], { name: "session.prompt", input: { sessionID: "s1", text: "hi" } });
});

test("runTurn: auto-rejects permission asks instead of hanging", async () => {
  const { client, calls } = fakeClient({
    "session.prompt": ({ sessionID }, { emit }) => later(() => {
      emit("permission.asked", { sessionID, id: "perm_1", action: "edit" });
      emit("session.execution.succeeded", { sessionID });
    }),
  });
  const r = await runTurn("s1", "fix it", { client });
  assert.equal(r.permissionsRejected, 1);
  assert.deepEqual(calls.find((c) => c.name === "permission.reply").input, { sessionID: "s1", requestID: "perm_1", decision: "reject" });
});

test("runTurn: reports failed, interrupted, timeout and closed streams", async () => {
  const fail = fakeClient({ "session.prompt": ({ sessionID }, { emit }) => later(() => emit("session.execution.failed", { sessionID, error: "429" })) });
  assert.equal((await runTurn("s", "x", { client: fail.client })).status, "failed");

  const intr = fakeClient({ "session.prompt": ({ sessionID }, { emit }) => later(() => emit("session.execution.interrupted", { sessionID })) });
  assert.equal((await runTurn("s", "x", { client: intr.client })).status, "interrupted");

  const silent = fakeClient();
  assert.equal((await runTurn("s", "x", { client: silent.client, timeoutMs: 20 })).status, "timeout");

  const closed = fakeClient({ "session.prompt": () => later(() => closed.closeAll()) });
  const r = await runTurn("s", "x", { client: closed.client });
  assert.equal(r.status, "failed");
  assert.match(r.error, /stream closed/);
});

test("runTurn: prompt errors propagate and unsubscribe", async () => {
  const f = fakeClient({ "session.prompt": () => { throw new Error("server down"); } });
  await assert.rejects(runTurn("s", "x", { client: f.client }), /server down/);
  assert.equal(f.subscribers.size, 0);
});

test("READONLY_PERMISSIONS deny every write path", () => {
  for (const a of ["edit", "write", "bash", "task"]) {
    assert.ok(READONLY_PERMISSIONS.some((r) => r.action === a && r.effect === "deny" && r.resource === "*"), a);
  }
});

test("isQuotaError", () => {
  assert.equal(isQuotaError({ message: "Rate-limit exceeded" }), true);
  assert.equal(isQuotaError("HTTP 429"), true);
  assert.equal(isQuotaError("boom"), false);
});
