// Step 3 exit: Jarvis can launch a worker and you can stop it.
// Proves: spawn -> tool start/idle -> permission asked -> deny wins -> stop + delete.
import fs from "node:fs";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
const { spawnWorker, stopWorker, deleteWorker, replyPermission, snapshot, routeUtterance } = await import("../apps/main/src/fleet.js");
import { ensureClient } from "../apps/main/src/service.js";

// Voice/hand routing is pure and tested here, not just wired.
const routingCases = [
  ["allow", true, "permission"], ["yes", true, "permission"], ["deny", true, "permission"], ["no", true, "permission"],
  ["allow", false, "prompt"], ["dim the fleet", true, "prompt"], ["stop the worker", false, "stop-worker"],
];
for (const [text, pending, want] of routingCases) {
  const got = routeUtterance(text, pending).route;
  if (got !== want) throw new Error(`route ${JSON.stringify(text)} pending=${pending}: got ${got}, want ${want}`);
  // Flaky-transcript guard: near-miss control words must NOT trigger controls.
  if (text === "dim the fleet" && got !== "prompt") throw new Error("eval leak");
}
console.log("route-ok: allow/deny/stop route to controls, everything else prompts");

const seen = [];
const onEvent = (ev) => seen.push(ev.kind);
const { client } = await ensureClient();

// 1. Launch + tool state.
const w1 = await spawnWorker("Run `ls` in the shell and report the first 3 entries. Do not edit files.", { onEvent });
console.log(`worker1=${w1.sessionID}`);
await waitFor(() => seen.includes("worker.tool") && snapshot().find((w) => w.id === w1.sessionID)?.state !== "working" || seen.includes("worker.done"), 90000, "tool activity");
const w1state = snapshot().find((w) => w.id === w1.sessionID);
console.log(`tool-ok state=${w1state?.state} tools=${w1state?.toolCount}`);
if (!w1state || w1state.toolCount < 1) throw new Error("no tool activity observed");

// 2. Permission gate: external write asks, deny wins, file absent.
seen.length = 0;
let gate = null, denied = null;
const w2 = await spawnWorker("Create file /tmp/jarvis-fleet-gate-proof.txt with content gate-proof. Use the write tool.", {
  onEvent: (ev) => {
    seen.push(ev.kind);
    if (ev.kind === "permission.waiting" && !denied) {
      gate = ev.request;
      // Reply inside the handler: an auto-approver resolves idle gates fast.
      denied = replyPermission(ev.request.requestID, "deny").then(() => "sent").catch((e) => `err:${e.message}`);
    }
  },
});
console.log(`worker2=${w2.sessionID}`);
await waitFor(() => gate !== null, 90000, "permission.asked");
console.log(`gate-ok action=${gate.action} resources=${gate.resources}`);
console.log(`deny-${await denied}`);
await new Promise((r) => setTimeout(r, 5000));
if (fs.existsSync("/tmp/jarvis-fleet-gate-proof.txt")) throw new Error("gate failed: file was written after deny");
console.log("gate-ok: deny won, file absent");

// 3. Stop + delete.
const w3 = await spawnWorker("Run `sleep 30 && echo done` in the shell and report the result.", { onEvent });
await new Promise((r) => setTimeout(r, 8000));
await stopWorker(w3.sessionID);
console.log("stop-ok");
await deleteWorker(w3.sessionID);
await deleteWorker(w2.sessionID).catch(() => {});
await deleteWorker(w1.sessionID).catch(() => {});
const list = await client.session.list();
const ids = JSON.stringify(list);
if (ids.includes(w3.sessionID)) throw new Error("delete failed: worker still listed");
console.log("delete-ok");
console.log("fleet-ok");
process.exit(0);

async function waitFor(cond, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let v = false;
    try { v = cond(); } catch {}
    if (v) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${what}; seen=${seen.join(",")}`);
}
