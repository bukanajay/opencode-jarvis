// Jarvis brain: LangGraph loop, OpenCode session as the reasoner.
// Nodes: recall → think → act → persist. One brain session per project, each
// read-only (READONLY_PERMISSIONS): it may read the project to answer, never
// change it. Luna default, switchable via the OpenCode model list
// (JARVIS_BRAIN_MODEL or setBrainModel). No new provider keys.
import { StateGraph, Annotation } from "@langchain/langgraph";
import { ensureClient } from "../service.js";
import { runTurn, isQuotaError, READONLY_PERMISSIONS, BRAIN_AGENT } from "../turn.js";
import { getFleetRegistry } from "../autoroute.js";
import { JARVIS_MODEL, JARVIS_FALLBACK_MODEL, parseModelRef } from "../sessions.js";
import { loadMemory, saveMemory, remember, extractCandidates, loadProjectMemory, recallAll, extractProjectCandidates } from "./memory.js";
import { projectDir, projectName } from "../project.js";
import { speechFor } from "../speech.js";
import { buildReviewPrompt, MAX_ROUNDS } from "./report.js";
import { loadStore } from "../shell.js";

const brainSessions = new Map(); // directory -> sessionID
let brainModelUsed = null;
let compiled = null;

export function wantedBrainModel() {
  let shellModel = null;
  try { shellModel = parseModelRef(loadStore().settings.jarvisModel); } catch {}
  return parseModelRef(process.env.JARVIS_BRAIN_MODEL) ?? shellModel ?? loadMemory().preferences.brainModel ?? JARVIS_MODEL;
}

export function getBrainModel() {
  return brainModelUsed ?? wantedBrainModel();
}

export async function setBrainModel(providerID, id) {
  if (!providerID || !id) throw new Error("brain model: providerID + id required");
  const { client } = await ensureClient();
  const list = await client.model.list();
  const all = list.models ?? list.data ?? [];
  const ok = (Array.isArray(all) ? all : []).some((m) => m.providerID === providerID && (m.modelID ?? m.id) === id);
  if (!ok) throw new Error(`unknown model: ${providerID}/${id}`);
  const mem = loadMemory();
  mem.preferences.brainModel = { providerID, id };
  saveMemory(mem);
  for (const sessionID of brainSessions.values()) {
    await client.session.switchModel({ sessionID, model: { providerID, id } });
  }
  brainModelUsed = { providerID, id };
  return brainModelUsed;
}

async function createBrainSession(directory, model) {
  const { client } = await ensureClient();
  const session = await client.session.create({
    agent: BRAIN_AGENT,
    model,
    location: { directory },
    title: "jarvis brain",
    permissions: READONLY_PERMISSIONS,
  });
  brainSessions.set(directory, session.id);
  brainModelUsed = model;
  return session.id;
}

export async function ensureBrainSession(directory = projectDir()) {
  return brainSessions.get(directory) ?? createBrainSession(directory, wantedBrainModel());
}

const BrainState = Annotation.Root({
  text: Annotation({ reducer: (_a, b) => b, default: () => "" }),
  files: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  voice: Annotation({ reducer: (_a, b) => b, default: () => false }),
  speak: Annotation({ reducer: (_a, b) => b, default: () => null }),
  memories: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  reply: Annotation({ reducer: (_a, b) => b, default: () => "" }),
  status: Annotation({ reducer: (_a, b) => b, default: () => "ok" }),
  facts: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  dispatches: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  warnings: Annotation({ reducer: (_a, b) => b, default: () => [] }),
});

// Act convention: think may emit single-line ```dispatch {"task": "...", "agent": "optional-id"}```
// fences, one per task; a review turn may instead emit ```followup {"task": "..."}```
// to send the reporting worker its next step. Single-line only, so the streamer
// can hold them back and the transcript stays readable. Only these shapes
// execute; everything else is words. Malformed fences are ignored with a
// warning, never executed.
const FENCE_RE = /^```(dispatch|followup|speak)\s+(.+?)\s*```[ \t]*$/gm;
const DISPATCH_LINE = /^\s*```(?:dispatch|followup|speak)\s+\{.*\}\s*```\s*$/;

function parseFences(reply, kind, allowed) {
  const out = [];
  const warnings = [];
  for (const m of String(reply ?? "").matchAll(FENCE_RE)) {
    if (m[1] !== kind) continue;
    let spec;
    try {
      spec = JSON.parse(m[2].trim());
    } catch {
      warnings.push(`ignoring malformed ${kind} fence: ${m[2].trim().slice(0, 80)}`);
      continue;
    }
    const task = String(spec?.task ?? "").trim();
    if (!task || task.length > 2000 || task.includes("\n")) {
      warnings.push(`ignoring ${kind} with bad task (empty, multiline, or >2000 chars)`);
      continue;
    }
    const agent = spec?.agent == null ? null : String(spec.agent).trim().toLowerCase();
    if (agent && !/^[a-z0-9-]{1,48}$/.test(agent)) {
      warnings.push(`ignoring ${kind} with bad agent id: ${JSON.stringify(spec.agent)}`);
      continue;
    }
    if (spec && typeof spec === "object" && Object.keys(spec).some((k) => !allowed.includes(k))) {
      warnings.push(`ignoring ${kind} with extra keys: ${Object.keys(spec).join(",")}`);
      continue;
    }
    out.push(kind === "dispatch" ? { task, agent } : { task });
  }
  return { out, warnings };
}

export function parseDispatches(reply) {
  const { out, warnings } = parseFences(reply, "dispatch", ["task", "agent"]);
  return { dispatches: out, warnings };
}

export function parseFollowups(reply) {
  const { out, warnings } = parseFences(reply, "followup", ["task"]);
  return { followups: out, warnings };
}

export function stripDispatches(reply) {
  return String(reply ?? "").split("\n").filter((ln) => !DISPATCH_LINE.test(ln)).join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Incremental streamer: forwards complete non-fence lines, holds fence lines
// and partial lines back. flush() emits the tail (unless it is a fence).
export function fencedFilter(forward) {
  let buf = "";
  return {
    push(chunk) {
      buf += String(chunk ?? "");
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const ln of lines) {
        if (DISPATCH_LINE.test(ln)) continue;
        forward(ln + "\n");
      }
    },
    flush() {
      if (buf && !DISPATCH_LINE.test(buf)) forward(buf);
      buf = "";
    },
  };
}

// Voice mode: the reply is also spoken, so ask for a short spoken line the
// streamer holds back like any fence. The full reply still goes to the
// transcript; speechFor() falls back to a local summary if this is missing.
export const VOICE_ADDENDUM = `The user is listening by voice. Also add exactly one single-line fence with what you would SAY out loud: one or two short plain sentences (under 40 words) summarising your reply, no code, file paths, symbols or markdown:\n\`\`\`speak {"text": "<spoken summary>"}\`\`\`\n`;

export function buildThinkPrompt(text, memories, registry, project = null, { voice = false } = {}) {
  const projLine = project?.dir ? `Current project: ${project.name} (${project.dir}). ` : "";
  const memLine = memories.length > 0
    ? `What you remember about the user:\n- ${memories.join("\n- ")}\n` : "";
  const fleetLine = (registry ?? []).length > 0
    ? `Fleet agents you can delegate to: ${(registry ?? []).map((a) => `${a.id}${a.description ? ` (${a.description.slice(0, 80)})` : ""}`).join("; ")}. Omit "agent" to let routing decide.\n`
    : `No fleet agents exist yet; do not emit dispatch fences, say what you need instead.\n`;
  return `You are Jarvis, a concise voice-and-text development assistant that can delegate work to a fleet of subagents. ${projLine}${memLine}${fleetLine}You have read-only access to the project: read, grep, glob and list files yourself to answer questions about the code, and to write precise tasks (name the files and functions involved). You cannot edit files or run commands. When the user asks you to CHANGE or RUN something (edit, fix, implement, run tests, build), you MUST delegate with a fence or the task is dropped. Reply briefly in your own voice AND append one single-line fence per task (no newlines inside the JSON):\n\`\`\`dispatch {"task": "<self-contained instruction>", "agent": "<optional id>"}\`\`\`\nKeep the visible reply short; for code questions answer from what you read. Never put anything but {"task", "agent?"} in a dispatch fence. ${voice ? VOICE_ADDENDUM : ""}User: ${text}`;
}

// One streamed turn on the brain session, fences held back from the stream.
// Quota/rate-limit failures retry once on the fallback model.
async function brainTurn(prompt, onDelta, files, directory = projectDir()) {
  const sessionID = await ensureBrainSession(directory);
  const filter = fencedFilter((d) => onDelta?.(d));
  const turn = (sid) => runTurn(sid, prompt, { onDelta: (d) => filter.push(d), files });
  let r = await turn(sessionID);
  if (r.status === "failed" && isQuotaError(r.error)) {
    r = await turn(await createBrainSession(directory, JARVIS_FALLBACK_MODEL));
  }
  filter.flush();
  return r;
}

// The brain is one session: user turns and worker reviews must not overlap,
// or their streams interleave in one deck bubble and the server queues
// prompts on a busy session. Every brain entry point goes through here.
let queue = Promise.resolve();
export function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function buildGraph(handlers) {
  const g = new StateGraph(BrainState);
  g.addNode("recall", async (state) => {
    return { memories: (await recallAll(state.text)).map((f) => f.text) };
  });
  g.addNode("think", async (state) => {
    const { client } = await ensureClient();
    const registry = await getFleetRegistry(client, projectDir()).catch(() => []);
    const prompt = buildThinkPrompt(state.text, state.memories, registry, { dir: projectDir(), name: projectName() }, { voice: state.voice });
    const r = await brainTurn(prompt, handlers.onDelta, state.files);
    return { reply: r.text, status: r.status };
  });
  g.addNode("act", async (state) => {
    // Parse only; execution belongs to main (shared dispatchTask), which owns
    // autoroute + bootstrap gate + spawn + deck broadcast. Displayed reply drops
    // the fences so the transcript stays readable.
    if (state.status !== "ok") return { dispatches: [], warnings: [] };
    const { dispatches, warnings } = parseDispatches(state.reply);
    const speak = state.voice ? speechFor(state.reply) : null;
    return { reply: stripDispatches(state.reply), dispatches, warnings, speak };
  });
  g.addNode("persist", async (state) => {
    // "remember for this project …" goes to project memory; everything else
    // the heuristics catch is about the user and stays global.
    const saved = [];
    const projectFacts = extractProjectCandidates(state.text);
    const mem = projectFacts.length ? loadProjectMemory() : loadMemory();
    for (const c of projectFacts.length ? projectFacts : extractCandidates(state.text)) {
      const f = remember(mem, c, ["auto"]);
      if (f) saved.push(f.text);
    }
    return { facts: saved };
  });
  g.addEdge("__start__", "recall");
  g.addEdge("recall", "think");
  g.addEdge("think", "act");
  g.addEdge("act", "persist");
  g.addEdge("persist", "__end__");
  return g.compile();
}

// One brain turn: memory in, streamed reply out, dispatch intents + facts out.
export function brainRespond(text, onDelta, opts = {}) {
  return serialize(async () => {
    compiled = buildGraph({ onDelta });
    const out = await compiled.invoke({ text, files: opts.files ?? [], voice: opts.voice === true });
    compiled = null;
    return { reply: out.reply, status: out.status ?? "ok", modelUsed: brainModelUsed, memoriesUsed: out.memories ?? [], facts: out.facts ?? [], dispatches: out.dispatches ?? [], warnings: out.warnings ?? [], speak: out.speak ?? null };
  });
}

// Pure decision over a review reply: at most one fence acts, and none once
// the chain is out of rounds. Followups win over dispatches when both appear.
export function decideReview(reply, round, maxRounds = MAX_ROUNDS) {
  const f = parseFollowups(reply);
  const d = parseDispatches(reply);
  const warnings = [...f.warnings, ...d.warnings];
  const fences = f.followups.length + d.dispatches.length;
  if (fences > 0 && round >= maxRounds) {
    return { followup: null, dispatch: null, warnings: [...warnings, `round limit ${maxRounds} reached; ignoring ${fences} fence(s)`] };
  }
  if (fences > 1) warnings.push(`review emitted ${fences} fences; acting on the first only`);
  const followup = f.followups[0] ?? null;
  const dispatch = followup ? null : d.dispatches[0] ?? null;
  return { followup, dispatch, warnings };
}

// Review turn for a finished worker: report in, streamed verdict out, at most
// one next step (followup to the same worker, or a new dispatch). Execution
// stays in main, like brainRespond.
export function brainReview(report, onDelta, { voice = false } = {}) {
  return serialize(async () => {
    const { client } = await ensureClient();
    // Review in the worker's own project, even if the user switched away.
    const directory = report.project ?? projectDir();
    const [memories, registry] = await Promise.all([
      recallAll(report.task, 6, directory).then((fs) => fs.map((f) => f.text)).catch(() => []),
      getFleetRegistry(client, directory).catch(() => []),
    ]);
    const prompt = buildReviewPrompt(report, { memories, registry }) + (voice ? `\n${VOICE_ADDENDUM}` : "");
    const r = await brainTurn(prompt, onDelta, undefined, directory);
    if (r.status !== "ok") return { reply: r.text, status: r.status, modelUsed: brainModelUsed, followup: null, dispatch: null, warnings: [], speak: null };
    const decision = decideReview(r.text, report.round);
    return { reply: stripDispatches(r.text), status: r.status, modelUsed: brainModelUsed, ...decision, speak: voice ? speechFor(r.text) : null };
  });
}
