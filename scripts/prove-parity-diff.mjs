// Parity 5 — Diff, undo, redo. Worker edits, diff shows it, undo restores,
// redo fork preserves the branch.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
const { spawnWorker, deleteWorker, getDiff, listMessages, undoMessage, listSessions } = await import("../apps/main/src/fleet.js");
import { ensureClient } from "../apps/main/src/service.js";

const { client } = await ensureClient();
const bait = "PROBE_UNDO.md";
try { fs.unlinkSync(path.join(process.cwd(), bait)); } catch {}

const w = await spawnWorker(`Create file ${bait} with content undo-probe. Use the write tool.`);
await waitDone(client, w.sessionID, 120000);
if (!fs.existsSync(bait)) throw new Error("setup: worker did not write the file");

const diff1 = await getDiff(w.sessionID);
const files1 = JSON.stringify(diff1);
if (!files1.includes(bait)) throw new Error(`diff missing the edit (${files1.slice(0, 200)})`);
console.log("diff-ok: edit visible in session diff");

const msgs = await listMessages(w.sessionID);
const arr = msgs.data ?? msgs.messages ?? msgs ?? [];
const withTools = (Array.isArray(arr) ? arr : []).filter(
  (m) => (m.type ?? m.role) === "assistant" && (m.content ?? []).some((p) => p.type === "tool"),
);
if (withTools.length === 0) throw new Error("no tool-call message to undo");
// Undo target resolution lives in undoMessage (user-message boundary).
const undo = await undoMessage(w.sessionID);
console.log(`undo-target: ${undo.messageID.slice(0, 16)} redo=${undo.redoID?.slice(0, 12)}`);
if (!undo.redoID) throw new Error("undo produced no redo branch");
if (fs.existsSync(bait)) throw new Error("undo did not restore the file");
const diff2 = JSON.stringify(await getDiff(w.sessionID));
if (diff2.includes(bait)) throw new Error("diff still shows the edit after undo");
console.log("undo-ok: file restored, diff clean");

const listed = JSON.stringify(await listSessions());
if (!listed.includes(undo.redoID)) throw new Error("redo fork missing from session list");
console.log(`redo-ok: branch preserved (${undo.redoID.slice(0, 12)})`);

await client.session.remove({ sessionID: undo.redoID }).catch(() => {});
await deleteWorker(w.sessionID).catch(() => {});
console.log("undoredo-ok");
process.exit(0);

async function waitDone(c, sessionID, ms) {
  const sub = c.event.subscribe();
  try {
    return await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("worker timeout")), ms);
      (async () => {
        for await (const ev of sub) {
          const d = ev.data ?? {};
          if (d.sessionID !== sessionID) continue;
          if (ev.type === "session.execution.succeeded") { clearTimeout(to); resolve(); }
          if (ev.type === "session.execution.failed") { clearTimeout(to); reject(new Error("worker failed")); }
        }
      })().catch(reject);
    });
  } finally {
    if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
  }
}
