// Fleet: child sessions under Jarvis, tool state, permission gate.
// One shared event pump tracks all workers. State per worker:
// idle | working | permission | done | failed | stopped
import { ensureClient } from "./service.js";
import { ensureJarvisSession, parseModelRef, JARVIS_MODEL } from "./sessions.js";

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
    w = { sessionID, task: "", state: "idle", tools: [], transcript: "", reasoning: "", pending: null, model: null };
    workers.set(sessionID, w);
  }
  return w;
}

function workerEvent(sessionID) {
  const w = record(sessionID);
  return {
    id: sessionID,
    task: w.task,
    state: w.state,
    toolCount: w.tools.length,
    pending: w.pending ? { requestID: w.pending.requestID, action: w.pending.action, resources: w.pending.resources } : null,
  };
}

export function snapshot() {
  return [...workers.values()].map((w) => workerEvent(w.sessionID));
}

export async function ensureFleetPump(onEvent) {
  if (onEvent) listeners.add(onEvent);
  if (pumpStarted) return;
  pumpStarted = true;
  const { client } = await ensureClient();
  const sub = client.event.subscribe();
  (async () => {
    for await (const ev of sub) {
      const d = ev.data ?? {};
      const sid = d.sessionID;
      if (!sid) continue;
      if (!workers.has(sid)) continue;
      const w = record(sid);
      const emit = (msg) => { for (const fn of listeners) { try { fn({ ...msg, snapshot: snapshot() }); } catch {} } };
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
          emit({ kind: "worker.done", sessionID: sid, status: "ok" });
          break;
        case "session.execution.failed":
          w.state = "failed";
          emit({ kind: "worker.done", sessionID: sid, status: "failed", error: d.error });
          break;
        default:
          break;
      }
    }
  })();
}

export function resolveWorkerModel() {
  return parseModelRef(process.env.WORKER_MODEL) ?? parseModelRef(process.env.JARVIS_MODEL) ?? JARVIS_MODEL;
}

export async function spawnWorker(task, opts = {}) {
  const { client } = await ensureClient();
  const parentID = await ensureJarvisSession(process.cwd());
  const model = opts.model ?? resolveWorkerModel();
  const session = await client.session.create({
    parentID,
    agent: opts.agent ?? "build",
    model,
    location: { directory: process.cwd() },
    title: task.slice(0, 64),
  });
  const w = record(session.id);
  w.task = task;
  w.model = model;
  w.state = "idle";
  await ensureFleetPump(opts.onEvent);
  await client.session.prompt({ sessionID: session.id, text: task });
  return { sessionID: session.id, model };
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

export function latestActiveWorker() {
  const order = [...workers.values()].reverse();
  return order.find((w) => w.state === "working" || w.state === "permission" || w.state === "idle") ?? null;
}

// Pure routing: control phrase vs model prompt. Main decides; flaky transcripts cannot eval.
export function routeUtterance(text, hasPending = pendingPermissions.size > 0) {
  const t = String(text ?? "").trim().toLowerCase();
  if (hasPending) {
    if (/^(allow|yes|approve|grant)(\s+once)?$/.test(t)) return { route: "permission", decision: "allow" };
    if (/^(deny|no|reject|block)$/.test(t)) return { route: "permission", decision: "deny" };
  }
  if (/^stop( the)? worker$/.test(t)) return { route: "stop-worker" };
  return { route: "prompt" };
}
