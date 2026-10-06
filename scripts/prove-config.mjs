// Step 5 exit: say "add a read-only reviewer", then dispatch it.
// Plus: widening asks twice, discard writes nothing.
import fs from "node:fs";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
const { routeUtterance, spawnWorker, deleteWorker } = await import("../apps/main/src/fleet.js");
const { matchConfigCommand, applyAgentFile, removeAgentFile, stageWidening, confirmWidening } = await import("../apps/main/src/config.js");
import { ensureClient } from "../apps/main/src/service.js";
import { ensureJarvisSession, parseModelRef } from "../apps/main/src/sessions.js";
// Free-tier `opencode/*` models reject direct subagent sessions (403 FreeTierError),
// so reviewer dispatches ride an OpenRouter free model until Luna quota returns.
const REV_MODEL = parseModelRef(process.env.REVIEWER_MODEL) ?? { providerID: "openrouter", id: "apodex/apodex-1.1-mini:free" };

const DIR = process.cwd();
const { client } = await ensureClient();

// 1. Routing: config phrases classified, widening flagged, guards stay model-side.
const r1 = routeUtterance("add a read-only reviewer", false);
if (r1.route !== "config.apply" || r1.spec.kind !== "agent-file" || r1.spec.widening !== false) {
  throw new Error(`reviewer misrouted: ${JSON.stringify(r1)}`);
}
const r2 = routeUtterance("let every agent run any shell command", false);
if (r2.route !== "config.stage" || r2.spec.kind !== "permission-allow-rule" || !r2.spec.widening) {
  throw new Error(`allow-rule misrouted: ${JSON.stringify(r2)}`);
}
const r3 = routeUtterance("delete the worker", false);
if (r3.route !== "config.stage" || r3.spec.kind !== "session-delete") throw new Error("delete misrouted");
for (const t of ["add a read-only reviewer", "let every agent run any shell command"]) {
  if (!matchConfigCommand(t)?.summary) throw new Error(`no summary for ${t}`);
}
const r4 = routeUtterance("yes, apply it", false, true);
if (r4.route !== "config.confirm" || r4.confirmed !== true) throw new Error("confirm misrouted");
const r5 = routeUtterance("no", false, true);
if (r5.route !== "config.confirm" || r5.confirmed !== false) throw new Error("discard misrouted");
for (const t of ["add a reviewer with full shell access", "review the auth module", "save my api key"]) {
  const r = routeUtterance(t, false);
  if (r.route === "config.apply" || r.route === "config.stage") throw new Error(`eval leak: ${t}`);
}
console.log("route-ok: reviewer direct, allow-rule + delete staged, confirms classified");

// 2. Agent file: Main writes watched file, server reloads, list confirms.
const spec = matchConfigCommand("add a read-only reviewer");
const applied = await applyAgentFile(client, DIR, spec);
if (applied.mode !== "subagent" || applied.editEffect !== "deny" || !applied.live) {
  throw new Error(`reviewer not confirmed: ${JSON.stringify(applied)}`);
}
console.log(`config-ok: ${applied.note}`);

// 3. Dispatch the reviewer on a real review task.
const w1 = await spawnWorker("Review apps/main/src/shell.js for input-validation gaps. Report only, change nothing.", { agent: "reviewer", model: REV_MODEL });
await waitForDone(client, w1.sessionID, 120000);
console.log("dispatch-ok: reviewer completed a review");

// 4. Read-only: explicit edit instruction must not create the file.
const bait = "PROBE_REVIEWER_BAIT.md";
try { fs.unlinkSync(bait); } catch {}
const w2 = await spawnWorker(`Create file ${bait} with content bait. Use the write tool.`, { agent: "reviewer", model: REV_MODEL });
await waitForDone(client, w2.sessionID, 120000);
if (fs.existsSync(bait)) throw new Error("reviewer wrote a file despite edit deny");
console.log("readonly-ok: edit instruction produced no file");

// 5. Widening: staged rule shows itself, second confirm applies; discard writes nothing.
const staged = stageWidening(matchConfigCommand("let every agent run any shell command"));
console.log(`staged-ok: ${staged.summary} rule=${JSON.stringify({ action: staged.action, resources: staged.resources, effect: staged.effect })}`);
const jarvisID = await ensureJarvisSession(DIR);
const done = await confirmWidening(client, DIR, staged.pendingID, true, { jarvisSessionID: async () => jarvisID });
if (!done.applied) throw new Error("widening confirm did not apply");
console.log(`widen-ok: second confirm applied (${JSON.stringify(done.saved).slice(0, 80)})`);
const w3 = await spawnWorker("Run `sleep 20 && echo done` in the shell.", {});
const stagedDel = stageWidening({ ...matchConfigCommand("delete the worker"), target: w3.sessionID });
const dropped = await confirmWidening(client, DIR, stagedDel.pendingID, false, { deleteTarget: async () => { throw new Error("must not run"); } });
if (dropped.applied !== false) throw new Error("discard applied something");
const list = await client.session.list();
if (!JSON.stringify(list).includes(w3.sessionID)) throw new Error("discarded delete still deleted");
console.log("discard-ok: worker alive after discard");

// 6. Cleanup: reviewer file removed, workers deleted.
await deleteWorker(w1.sessionID).catch(() => {});
await deleteWorker(w2.sessionID).catch(() => {});
await deleteWorker(w3.sessionID).catch(() => {});
const removed = await removeAgentFile(client, DIR, "reviewer");
if (!removed.removed) throw new Error("reviewer removal not reflected in agent list");
console.log("cleanup-ok: reviewer gone from agent list");
console.log("config-ok");
process.exit(0);

async function waitForDone(c, sessionID, ms) {
  const sub = c.event.subscribe();
  const t0 = Date.now();
  try {
    for await (const ev of sub) {
      const d = ev.data ?? {};
      if (d.sessionID !== sessionID) continue;
      if (ev.type === "session.execution.succeeded") return;
      if (ev.type === "session.execution.failed") throw new Error(`worker failed: ${JSON.stringify(d.error).slice(0, 200)}`);
      if (Date.now() - t0 > ms) throw new Error("worker timeout");
    }
  } finally {
    if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
  }
}
