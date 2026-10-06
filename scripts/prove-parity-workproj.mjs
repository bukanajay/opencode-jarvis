// Parity 8 — Worktrees, project switch, compaction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
const { spawnWorker, deleteWorker, listProjects, projectIDFor, listWorktrees, createWorktree, removeWorktree, compactSession } = await import("../apps/main/src/fleet.js");
import { ensureClient } from "../apps/main/src/service.js";

const { client } = await ensureClient();

// 1. Project switch: this repo is a known project.
const pid = await projectIDFor(process.cwd());
console.log(`project-ok: ${pid.slice(0, 12)} (${process.cwd()})`);

// 2. Worktree: create branch worktree, see it, remove it.
const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-wt-"));
const branch = `prove/wt-${Date.now().toString(36)}`;
const wt = await createWorktree(pid, { from: process.cwd(), branch: "master", name: branch, directory: wtParent });
const wtDir = wt.directory ?? wt.path;
console.log(`worktree-ok: created ${JSON.stringify(wt.directory ?? wt.path ?? wtDir).slice(0, 80)}`);
const listed = await listWorktrees(pid);
if (!JSON.stringify(listed).includes(wtDir) && !JSON.stringify(listed).includes(branch)) {
  throw new Error("worktree not listed after create");
}
console.log("worktree-ok: listed");
await removeWorktree(pid, wt.directory ?? wtDir);
const after = await listWorktrees(pid);
if (JSON.stringify(after).includes(wtDir)) throw new Error("worktree still listed after remove");
console.log("worktree-ok: removed, gone from list");
await import("node:child_process").then(async ({ execFile }) => {
  await new Promise((r) => execFile("git", ["worktree", "prune"], { cwd: process.cwd() }, () => r()));
  await new Promise((r) => execFile("git", ["branch", "-D", branch], { cwd: process.cwd() }, () => r()));
});

// 3. Project switch: a worker outside this repo completes a turn.
const other = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-proj-"));
fs.writeFileSync(path.join(other, "note.txt"), "external project\n");
const w = await spawnWorker("Reply with exactly: proj-ok. No tools.", { directory: other });
await waitDone(client, w.sessionID, 120000);
console.log("switch-ok: external-directory worker completed");

// 4. Compaction: session still answers after compact.
await compactSession(w.sessionID);
console.log("compact-ok: compaction accepted");
const sub = client.event.subscribe();
const p = new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error("post-compact turn timeout")), 120000);
  (async () => {
    for await (const ev of sub) {
      const d = ev.data ?? {};
      if (d.sessionID !== w.sessionID) continue;
      if (ev.type === "session.execution.succeeded") { clearTimeout(to); resolve(); }
      if (ev.type === "session.execution.failed") { clearTimeout(to); reject(new Error("post-compact turn failed")); }
    }
  })().catch(reject);
});
await client.session.prompt({ sessionID: w.sessionID, text: "Reply with exactly: after-compact. No tools." });
await p;
if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
console.log("compact-ok: session answers after compact");
await deleteWorker(w.sessionID).catch(() => {});
fs.rmSync(other, { recursive: true, force: true });
console.log("workproj-ok");
process.exit(0);

async function waitDone(c, sessionID, ms) {
  const sub = c.event.subscribe();
  try {
    await new Promise((resolve, reject) => {
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
