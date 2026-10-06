// Fleet: child sessions under Jarvis, tool state, permission gate.
// One shared event pump tracks all workers. State per worker:
// idle | working | permission | done | failed | stopped
import { ensureClient } from "./service.js";
import { ensureJarvisSession, parseModelRef, JARVIS_MODEL } from "./sessions.js";
import { matchAppCommand, loadStore } from "./shell.js";
import { matchConfigCommand, isWidening, pendingConfigs } from "./config.js";
import { refreshForms, pendingForms } from "./forms.js";
import { chains, publicChain } from "./worktrees.js";
import { projectDir } from "./project.js";

export const workers = new Map(); // sessionID -> worker record
export const pendingPermissions = new Map(); // requestID -> { sessionID, request }

let pumpStarted = false;
const listeners = new Set();

export function onFleetEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function record(sessionID) {
  let w = workers.get(sessionID);
  if (!w) {
    // chain: root worker of a delegation chain; round: follow-ups so far.
    w = { sessionID, task: "", state: "idle", tools: [], transcript: "", reasoning: "", pending: null, model: null, chain: sessionID, round: 0 };
    workers.set(sessionID, w);
  }
  return w;
}

function workerEvent(sessionID) {
  const w = record(sessionID);
  return {
    id: sessionID,
    task: w.task,
    agent: w.agent ?? "build",
    state: w.state,
    toolCount: w.tools.length,
    round: w.round,
    chain: w.chain,
    worktree: publicChain(chains.get(w.chain)),
    pending: w.pending ? { requestID: w.pending.requestID, action: w.pending.action, resources: w.pending.resources } : null,
  };
}

// The ring shows the current project's workers; the pump tracks them all.
export function snapshot(dir = projectDir()) {
  return [...workers.values()].filter((w) => !w.project || w.project === dir).map((w) => workerEvent(w.sessionID));
}

export function publicForm(f) {
  return {
    formID: f.id ?? f.formID,
    sessionID: f.sessionID,
    title: f.title,
    fields: (f.fields ?? []).map((fd) => ({
      key: fd.key,
      title: fd.title,
      description: fd.description,
      type: fd.type,
      options: (fd.options ?? []).map((o) => ({ value: o.value, label: o.label, description: o.description })),
    })),
  };
}

export async function listSessions() {
  const { client } = await ensureClient();
  return client.session.list();
}

export async function renameSession(sessionID, title) {
  const { client } = await ensureClient();
  if (!title || typeof title !== "string") throw new Error("rename: title required");
  await client.session.update({ sessionID, title });
  const w = workers.get(sessionID);
  if (w) w.task = title;
  return { ok: true, sessionID, title };
}

export async function forkSession(sessionID, before) {
  const { client } = await ensureClient();
  const fork = await client.session.fork(before ? { sessionID, before } : { sessionID });
  const id = fork?.id ?? fork?.data?.id ?? null;
  return { ok: true, sessionID, forkID: id };
}

export async function switchSessionAgent(sessionID, agent) {
  const { client } = await ensureClient();
  if (!agent || typeof agent !== "string") throw new Error("switch: agent required");
  await client.session.switchAgent({ sessionID, agent });
  return { ok: true, sessionID, agent };
}

export async function switchSessionModel(sessionID, providerID, id) {
  const { client } = await ensureClient();
  if (!providerID || !id) throw new Error("switch: providerID + id required");
  await client.session.switchModel({ sessionID, model: { providerID, id } });
  return { ok: true, sessionID, model: { providerID, id } };
}

export async function listAgents(location) {
  const { client } = await ensureClient();
  return client.agent.list(location ? { location: { directory: location } } : undefined);
}

export async function listModels() {
  const { client } = await ensureClient();
  return client.model.list();
}

export async function listProjects() {
  const { client } = await ensureClient();
  return client.project.list();
}

export async function projectIDFor(directory) {
  const list = await listProjects();
  const raw = list.data ?? list.projects ?? list;
  const arr = Array.isArray(raw) ? raw : [];
  const hit = arr.find((p) => p.canonical === directory);
  if (!hit) throw new Error(`no project for ${directory}`);
  return hit.id;
}

export async function listWorktrees(projectID) {
  const { client } = await ensureClient();
  return client.worktree.list({ projectID });
}

export async function createWorktree(projectID, { from, branch, directory, name } = {}) {
  const { client } = await ensureClient();
  return client.worktree.create({ projectID, from, branch, directory, name });
}

export async function removeWorktree(projectID, directory, force = true) {
  const { client } = await ensureClient();
  await client.worktree.remove({ projectID, directory, force });
  return { ok: true };
}

export async function compactSession(sessionID) {
  const { client } = await ensureClient();
  return client.session.compact({ sessionID });
}

export async function getDiff(sessionID) {
  const { client } = await ensureClient();
  return client.session.diff({ sessionID });
}

export async function listMessages(sessionID, limit = 50) {
  const { client } = await ensureClient();
  return client.message.list({ sessionID, limit, order: "asc" });
}

// Undo = fork first (redo branch), then stage + commit the revert on the original.
// Attribution lives on the step's first assistant message (reasoning+tool),
// not on the tool.called event's message. Redo = the pre-undo fork.
export async function undoMessage(sessionID, messageID) {
  const { client } = await ensureClient();
  const mid = messageID ?? (await findUndoTarget(client, sessionID));
  if (!mid) throw new Error("undo: no tool-call message found");
  const fork = await client.session.fork({ sessionID });
  const redoID = fork?.id ?? fork?.data?.id ?? null;
  if (redoID) {
    const w = record(redoID);
    w.task = `redo: fork of ${sessionID.slice(0, 8)}`;
    w.state = "idle";
  }
  await client.session.revert.stage({ sessionID, messageID: mid, files: true });
  await client.session.revert.commit({ sessionID });
  return { ok: true, sessionID, messageID: mid, redoID };
}

async function listAllMessages(client, sessionID) {
  const out = [];
  const seen = new Set();
  let cursor;
  for (let p = 0; p < 5; p++) {
    const m = await client.message.list({ sessionID, limit: 50, order: "asc", cursor });
    for (const x of (m.data ?? [])) {
      if (x?.id && !seen.has(x.id)) { seen.add(x.id); out.push(x); }
    }
    cursor = typeof m.cursor === "string" ? m.cursor : m.cursor?.next ?? null;
    if (!cursor) break;
  }
  return out;
}

export async function findUndoTarget(client, sessionID) {
  const all = await listAllMessages(client, sessionID);
  // Rollback boundary: the user message whose turn made the changes.
  // Staging it reverts everything after it (stage returns the reverse patch).
  for (let i = all.length - 1; i >= 0; i--) {
    if ((all[i].type ?? all[i].role) === "user" && i < all.length - 1) return all[i].id;
  }
  return null;
}

export async function listCommands() {
  const { client } = await ensureClient();
  return client.command.list();
}

export async function listSkills() {
  const { client } = await ensureClient();
  return client.skill.list();
}

export async function ensureFleetPump(onEvent) {
  if (onEvent) listeners.add(onEvent);
  if (pumpStarted) return;
  pumpStarted = true;
  const { client } = await ensureClient();
  const emit = (msg) => { for (const fn of listeners) { try { fn({ ...msg, snapshot: snapshot() }); } catch {} } };
  // The server stream ends or throws when the connection drops; without a
  // reconnect the ring freezes silently. Back off up to 30s, reset on traffic.
  (async () => {
    let failures = 0;
    for (;;) {
      try {
        await pumpOnce(client, emit, () => { failures = 0; });
      } catch (err) {
        console.error("fleet pump error:", err?.message ?? err);
      }
      failures += 1;
      emit({ kind: "fleet.pump", state: "reconnecting", attempt: failures });
      await new Promise((r) => setTimeout(r, Math.min(30000, 500 * 2 ** Math.min(failures, 6))));
    }
  })();
}

export async function pumpOnce(client, emit, onTraffic = () => {}) {
  const sub = client.event.subscribe();
  let first = true;
  for await (const ev of sub) {
    onTraffic();
    if (first) {
      first = false;
      reconcileWorkers(client, emit).catch(() => {});
    }
    handleFleetEvent(ev, emit);
  }
}

// One worker.done per execution. finishedAt guards against the live event and
// a reconcile both reporting the same run.
function finishWorker(w, status, error, emit) {
  if (w.finishedAt && w.finishedAt >= (w.promptedAt ?? 0)) return;
  w.finishedAt = Date.now();
  emit({ kind: "worker.done", sessionID: w.sessionID, status, error, round: w.round, chain: w.chain, agent: w.agent ?? "build", review: w.state !== "stopped" });
}

// After a (re)connect, events from the gap are gone. A worker the ring still
// shows as running whose session went idle since its last prompt finished
// while we were away: report it now so the review loop still sees it.
export async function reconcileWorkers(client, emit) {
  for (const w of [...workers.values()]) {
    if (!["working", "idle", "permission"].includes(w.state)) continue;
    const info = await client.session.get({ sessionID: w.sessionID }).catch(() => null);
    const idle = info?.time?.idle;
    if (!idle || idle < (w.promptedAt ?? 0) || !info.outcome) continue;
    if (info.outcome === "interrupted") {
      w.state = "stopped";
      continue;
    }
    w.state = info.outcome === "succeeded" ? "done" : "failed";
    finishWorker(w, info.outcome === "succeeded" ? "ok" : "failed", null, emit);
  }
}

// One server event → worker state + deck events. Exported for tests.
export function handleFleetEvent(ev, emit) {
  const d = ev.data ?? {};
  const sid = d.sessionID;
  if (!sid) return;
  if (!workers.has(sid)) return;
  const w = record(sid);
  switch (ev.type) {
    case "session.tool.input.started":
      w.tools.push({ id: d.id, name: d.name, state: "input" });
      w.state = w.pending ? "permission" : "working";
      emit({ kind: "worker.tool", sessionID: sid, tool: d.name ?? d.id, state: "start" });
      break;
    case "session.tool.input.ended":
      break;
    case "session.tool.called":
      w.state = "working";
      emit({ kind: "worker.tool", sessionID: sid, tool: d.id, state: "start" });
      if (d.name === "question" || (d.id ?? "").includes("question")) {
        refreshForms(sid).then((forms) => {
          if (forms.length > 0) {
            w.state = "working";
            emit({ kind: "form.waiting", sessionID: sid, forms: forms.map(publicForm) });
          }
        }).catch(() => {});
        setTimeout(() => {
          refreshForms(sid).then((forms) => {
            if (forms.length > 0) emit({ kind: "form.waiting", sessionID: sid, forms: forms.map(publicForm) });
          }).catch(() => {});
        }, 4000);
      }
      break;
    case "session.tool.progress":
      break;
    case "session.tool.success":
    case "session.tool.error": {
      const t = w.tools.find((t) => t.id === d.id);
      if (t) t.state = ev.type === "session.tool.success" ? "done" : "error";
      if (!w.pending) w.state = "idle";
      emit({ kind: "worker.tool", sessionID: sid, tool: d.id, state: "idle" });
      break;
    }
    case "session.text.delta":
      if (d.delta) {
        const chunk = typeof d.delta === "string" ? d.delta : d.delta.text ?? "";
        w.transcript += chunk;
        emit({ kind: "worker.stream", sessionID: sid, delta: chunk });
      }
      break;
    case "session.reasoning.delta":
      if (d.delta) w.reasoning += typeof d.delta === "string" ? d.delta : d.delta.text ?? "";
      break;
    case "permission.asked": {
      const req = { requestID: d.id, sessionID: sid, action: d.action, resources: d.resources ?? [], save: d.save ?? [] };
      w.pending = req;
      w.state = "permission";
      pendingPermissions.set(d.id, req);
      emit({ kind: "permission.waiting", request: req });
      break;
    }
    case "permission.replied": {
      pendingPermissions.delete(d.requestID);
      if (w.pending?.requestID === d.requestID) w.pending = null;
      if (w.state === "permission") w.state = "working";
      emit({ kind: "permission.resolved", sessionID: sid, requestID: d.requestID, reply: d.reply });
      break;
    }
    case "session.execution.succeeded":
      if (!w.pending) w.state = "done";
      finishWorker(w, "ok", null, emit);
      break;
    case "session.execution.failed":
      w.state = "failed";
      finishWorker(w, "failed", d.error, emit);
      break;
    case "session.execution.interrupted":
      // Stop button or server interrupt: the user is steering, never review it.
      w.state = "stopped";
      emit({ kind: "worker.done", sessionID: sid, status: "interrupted", round: w.round, chain: w.chain, agent: w.agent ?? "build", review: false });
      break;
    default:
      if (ev.type.startsWith("form.")) {
        refreshForms(sid).then((forms) => {
          if (forms.length > 0) emit({ kind: "form.waiting", sessionID: sid, forms: forms.map(publicForm) });
          else emit({ kind: "form.resolved", sessionID: sid });
        }).catch(() => {});
      }
      break;
  }
}

export function resolveWorkerModel() {
  const shellModel = (() => {
    try { return parseModelRef(loadStore().settings.workerModel); } catch { return null; }
  })();
  return parseModelRef(process.env.WORKER_MODEL) ?? parseModelRef(process.env.JARVIS_MODEL) ?? shellModel ?? JARVIS_MODEL;
}

export async function spawnWorker(task, opts = {}) {
  const { client } = await ensureClient();
  const project = opts.project ?? projectDir();
  const parentID = await ensureJarvisSession(project);
  const model = opts.model ?? resolveWorkerModel();
  const directory = opts.directory ?? project;
  const agent = opts.agent ?? "build";
  const round = opts.round ?? 0;
  const session = await client.session.create({
    parentID,
    agent,
    model,
    location: { directory },
    title: task.slice(0, 64),
    // Chain bookkeeping rides on the session so a restart can rebuild it.
    metadata: { jarvis: { task: task.slice(0, 2000), chain: opts.chain ?? null, round, project } },
  });
  const w = record(session.id);
  w.task = task;
  w.agent = agent;
  w.model = model;
  w.state = "idle";
  w.project = project;
  w.chain = opts.chain ?? session.id;
  w.round = round;
  w.promptedAt = Date.now();
  await ensureFleetPump(opts.onEvent);
  await client.session.prompt({ sessionID: session.id, text: task });
  return { sessionID: session.id, model };
}

// Next step for an existing worker, same session and context. Counts as a
// round of its chain so the review loop is bounded.
// Rebuild worker records for a project from its persisted parent session's
// children, so a restart keeps the ring, review loop and worktree chains.
export async function rehydrateWorkers(client, parentID, project) {
  const res = await client.session.list({ parentID, limit: 100, order: "desc" });
  const rows = res?.data ?? res?.sessions ?? (Array.isArray(res) ? res : []);
  let n = 0;
  for (const info of rows) {
    if (!info?.id || workers.has(info.id) || info.time?.archived) continue;
    const meta = info.metadata?.jarvis ?? {};
    const w = record(info.id);
    w.task = meta.task ?? info.title ?? "";
    w.agent = info.agent ?? "build";
    w.model = info.model ?? null;
    w.project = meta.project ?? project;
    w.chain = meta.chain ?? info.id;
    w.round = Number(meta.round ?? 0);
    w.state = info.outcome === "succeeded" ? "done" : info.outcome === "failed" ? "failed" : info.outcome === "interrupted" ? "stopped" : info.time?.idle ? "idle" : "working";
    // Already-finished runs are not re-reviewed after a restart.
    w.promptedAt = info.time?.created ?? 0;
    w.finishedAt = info.outcome ? Date.now() : 0;
    n++;
  }
  return n;
}

export async function followUpWorker(sessionID, task) {
  const w = workers.get(sessionID);
  if (!w) throw new Error(`followup: unknown worker ${sessionID}`);
  if (!task || typeof task !== "string") throw new Error("followup: task required");
  const { client } = await ensureClient();
  w.round = (w.round ?? 0) + 1;
  w.state = "working";
  w.promptedAt = Date.now();
  await client.session.prompt({ sessionID, text: task });
  client.session.update({ sessionID, metadata: { jarvis: { task: w.task.slice(0, 2000), chain: w.chain, round: w.round, project: w.project ?? null } } }).catch(() => {});
  return { ok: true, sessionID, round: w.round };
}

export async function stopWorker(sessionID) {
  const { client } = await ensureClient();
  await client.session.interrupt({ sessionID });
  const w = record(sessionID);
  w.state = "stopped";
  return { ok: true };
}

export async function deleteWorker(sessionID) {
  const { client } = await ensureClient();
  try { await client.session.interrupt({ sessionID }); } catch {}
  await client.session.remove({ sessionID });
  workers.delete(sessionID);
  return { ok: true };
}

export async function replyPermission(requestID, decision) {
  // decision: "allow" | "deny" -> "once" | "reject". Never "always" without Step-5 confirm.
  const { client } = await ensureClient();
  const pending = pendingPermissions.get(requestID);
  if (!pending) throw new Error(`no pending permission: ${requestID}`);
  const out = await client.permission.reply({
    sessionID: pending.sessionID,
    requestID,
    decision: decision === "allow" ? "once" : "reject",
  });
  return out;
}

// Most recent chain with an open worktree whose workers are all finished:
// the one "land it" / "discard it" means.
export function latestSettledChain() {
  for (const w of [...workers.values()].reverse()) {
    const c = chains.get(w.chain);
    if (!c || c.state !== "open") continue;
    const busy = [...workers.values()].some((x) => x.chain === w.chain && ["working", "permission"].includes(x.state));
    return busy ? { chainID: w.chain, busy: true } : { chainID: w.chain, busy: false };
  }
  return null;
}

export function chainBusy(chainID) {
  return [...workers.values()].some((x) => x.chain === chainID && ["working", "permission"].includes(x.state));
}

export function latestActiveWorker() {
  const order = [...workers.values()].reverse();
  return order.find((w) => w.state === "working" || w.state === "permission" || w.state === "idle") ?? null;
}

// Pure routing: control phrase vs model prompt. Main decides; flaky transcripts cannot eval.
export function routeUtterance(text, hasPending = pendingPermissions.size > 0, hasConfigPending = pendingConfigs.size > 0, formAnswer = null) {
  const t = String(text ?? "").trim().toLowerCase();
  if (hasPending) {
    if (/^(allow|yes|approve|grant)(\s+once)?$/.test(t)) return { route: "permission", decision: "allow" };
    if (/^(deny|no|reject|block)$/.test(t)) return { route: "permission", decision: "deny" };
  }
  if (formAnswer) return { route: "form.answer", answer: formAnswer };
  if (hasConfigPending) {
    if (/^(yes,? apply it|yes|confirm|apply it|do it)$/.test(t)) return { route: "config.confirm", confirmed: true };
    if (/^(no|cancel|never mind|don't|do not)$/.test(t)) return { route: "config.confirm", confirmed: false };
  }
  const app = matchAppCommand(text);
  if (app) return { route: "app.command", ...app };
  const cfg = matchConfigCommand(text);
  if (cfg && !isWidening(cfg)) return { route: "config.apply", spec: cfg };
  if (cfg && isWidening(cfg)) return { route: "config.stage", spec: cfg };
  if (/^stop( the)? worker$/.test(t)) return { route: "stop-worker" };
  let m;
  if ((m = t.match(/^(land|merge|keep|discard)( it| the work| the changes| the branch)?$/))) {
    return { route: "chain.action", action: m[1] === "merge" ? "land" : m[1] };
  }
  return { route: "prompt" };
}
