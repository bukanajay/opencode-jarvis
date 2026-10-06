// Parity 4 — Commands, skills, file mentions, attachments.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
const { spawnWorker, deleteWorker, listCommands, listSkills } = await import("../apps/main/src/fleet.js");
import { ensureClient } from "../apps/main/src/service.js";

const { client } = await ensureClient();

// 1. Catalogs exist.
const cmds = await listCommands();
const cmdNames = (cmds.data ?? []).map((c) => c.name);
if (cmdNames.length === 0) throw new Error("no commands listed");
console.log(`commands-ok: ${cmdNames.length} (${cmdNames.slice(0, 5).join(",")})`);
const skills = await listSkills();
const skillIds = (skills.data ?? []).map((s) => s.id ?? s.name);
if (skillIds.length === 0) throw new Error("no skills listed");
console.log(`skills-ok: ${skillIds.length} (${skillIds.slice(0, 3).join(",")})`);

// 2. Slash command runs a live turn on the shared server.
const w1 = await spawnWorker("Reply with exactly: cmds-ok. No tools.");
if ((await waitTurn(client, w1.sessionID, 120000)) !== "ok") throw new Error("worker first turn failed");
await client.session.command({ sessionID: w1.sessionID, name: "review", text: "uncommitted" });
const cmdDone = await waitTurn(client, w1.sessionID, 180000);
if (cmdDone !== "ok") throw new Error(`command turn failed (${cmdDone})`);
console.log("command-ok: /review turn completed");

// 3. Attachment: file content reaches the model and comes back quoted.
const token = `mention-token-${Date.now().toString(36)}`;
const probeFile = path.join(process.cwd(), "PROBE_ATTACHMENT.md");
fs.writeFileSync(probeFile, `# probe\nThe secret word is ${token}.\n`);
let quoted = "";
try {
  const w2 = await spawnWorker("noop");
  const sub = client.event.subscribe();
  const p = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("attachment turn timeout")), 120000);
    (async () => {
      for await (const ev of sub) {
        const d = ev.data ?? {};
        if (d.sessionID !== w2.sessionID) continue;
        if (ev.type === "session.text.delta" && d.delta) {
          quoted += typeof d.delta === "string" ? d.delta : d.delta.text ?? "";
        }
        if (ev.type === "session.execution.succeeded") { clearTimeout(to); resolve(); }
        if (ev.type === "session.execution.failed") { clearTimeout(to); reject(new Error("attachment turn failed")); }
      }
    })().catch(reject);
  });
  await client.session.prompt({
    sessionID: w2.sessionID,
    text: "Quote the secret word from the attached file, nothing else.",
    files: [{ uri: `file://${probeFile}`, name: "PROBE_ATTACHMENT.md" }],
  });
  await p;
  if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
  if (!quoted.includes(token)) throw new Error(`attachment not quoted (got ${JSON.stringify(quoted.slice(0, 120))})`);
  console.log("attach-ok: model quoted the attached file");
  await deleteWorker(w2.sessionID).catch(() => {});
} finally {
  try { fs.unlinkSync(probeFile); } catch {}
}

await deleteWorker(w1.sessionID).catch(() => {});
console.log("cmdskill-ok");
process.exit(0);

async function waitTurn(c, sessionID, ms) {
  const sub = c.event.subscribe();
  try {
    return await new Promise((resolve) => {
      const to = setTimeout(() => resolve("timeout"), ms);
      (async () => {
        for await (const ev of sub) {
          const d = ev.data ?? {};
          if (d.sessionID !== sessionID) continue;
          if (ev.type === "session.execution.succeeded") { clearTimeout(to); resolve("ok"); }
          if (ev.type === "session.execution.failed") { clearTimeout(to); resolve("failed"); }
        }
      })();
    });
  } finally {
    if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
  }
}
