// Parity 3 — Agent and model switch, Luna stays the Jarvis default.
import process from "node:process";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
const { spawnWorker, deleteWorker, switchSessionAgent, switchSessionModel } = await import("../apps/main/src/fleet.js");
import { ensureClient } from "../apps/main/src/service.js";
import { JARVIS_MODEL } from "../apps/main/src/sessions.js";

if (JARVIS_MODEL.providerID !== "opencode-go" || JARVIS_MODEL.id !== "gpt-6-luna") {
  throw new Error(`Luna is not the Jarvis default: ${JSON.stringify(JARVIS_MODEL)}`);
}
console.log("default-ok: Jarvis default is opencode-go/gpt-6-luna");

const { client } = await ensureClient();
const w = await spawnWorker("Reply with exactly: switch-ok. No tools.");
console.log(`worker=${w.sessionID}`);

await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error("first turn never finished")), 120000);
  (async () => {
    const sub = client.event.subscribe();
    for await (const ev of sub) {
      const d = ev.data ?? {};
      if (d.sessionID !== w.sessionID) continue;
      if (ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed") {
        clearTimeout(to);
        if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
        resolve();
      }
    }
  })().catch(reject);
});

await switchSessionAgent(w.sessionID, "plan");
await switchSessionModel(w.sessionID, "openrouter", "apodex/apodex-1.1-mini:free");
console.log("switch-ok: agent=plan model=openrouter/apodex");

const seen = await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error("no step after switch")), 120000);
  (async () => {
    const sub = client.event.subscribe();
    for await (const ev of sub) {
      const d = ev.data ?? {};
      if (d.sessionID !== w.sessionID) continue;
      if (ev.type === "session.step.started") {
        clearTimeout(to);
        if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
        resolve({ agent: d.agent, model: d.model });
      }
      if (ev.type === "session.execution.failed") {
        clearTimeout(to);
        if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
        reject(new Error(`failed after switch: ${JSON.stringify(d.error).slice(0, 160)}`));
      }
    }
  })().catch(reject);
  client.session.prompt({ sessionID: w.sessionID, text: "Reply with exactly: switch-ok. No tools." }).catch(reject);
});
if (seen.agent !== "plan") throw new Error(`agent switch not live (step ran ${seen.agent})`);
if (seen.model?.providerID !== "openrouter") throw new Error(`model switch not live (${JSON.stringify(seen.model)})`);
console.log(`live-ok: step ran agent=${seen.agent} model=${seen.model.providerID}/${seen.model.id}`);
await deleteWorker(w.sessionID).catch(() => {});
console.log("switch-ok");
process.exit(0);
