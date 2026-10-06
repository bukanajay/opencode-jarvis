// Parity 1 — Sessions: create, list, rename, fork, interrupt, delete.
import process from "node:process";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
const { spawnWorker, deleteWorker, listSessions, renameSession, forkSession } = await import("../apps/main/src/fleet.js");
import { ensureClient } from "../apps/main/src/service.js";

const { client } = await ensureClient();
const w = await spawnWorker("Reply with exactly: sessions-ok. No tools.");
console.log(`spawn-ok ${w.sessionID}`);

const t1 = `fleet-probe-${Date.now().toString(36)}`;
await renameSession(w.sessionID, t1);
const listed = await listSessions();
const entry = JSON.stringify(listed);
if (!entry.includes(w.sessionID)) throw new Error("list does not include worker");
const got = await client.session.get({ sessionID: w.sessionID }).catch(() => null);
const title = got?.data?.title ?? got?.title ?? null;
console.log(`rename-ok title=${JSON.stringify(title)}`);
if (title !== t1) throw new Error(`rename not reflected (got ${JSON.stringify(title)})`);

const fork = await forkSession(w.sessionID);
if (!fork.forkID) throw new Error("fork returned no id");
console.log(`fork-ok ${fork.forkID}`);

await deleteWorker(w.sessionID).catch(() => {});
await client.session.remove({ sessionID: fork.forkID }).catch(() => {});
const after = JSON.stringify(await listSessions());
if (after.includes(w.sessionID) || after.includes(fork.forkID)) throw new Error("delete incomplete");
console.log("delete-ok");
console.log("sessions-ok");
process.exit(0);
