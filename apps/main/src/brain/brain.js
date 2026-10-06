// Jarvis brain: LangGraph loop, OpenCode session as the reasoner.
// Nodes: recall → think → persist. Luna default, switchable via the OpenCode
// model list (JARVIS_BRAIN_MODEL or setBrainModel). No new provider keys.
import { StateGraph, Annotation } from "@langchain/langgraph";
import fs from "node:fs";
import path from "node:path";
import { ensureClient } from "../service.js";
import { getFleetRegistry } from "../autoroute.js";
import { JARVIS_MODEL, JARVIS_FALLBACK_MODEL, parseModelRef } from "../sessions.js";
import { loadMemory, remember, recall, extractCandidates } from "./memory.js";
import { loadStore } from "../shell.js";

let brainSessionID = null;
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
  fs.mkdirSync(path.dirname(mem.file), { recursive: true });
  fs.writeFileSync(mem.file, JSON.stringify({ facts: mem.facts, preferences: mem.preferences }, null, 2));
  if (brainSessionID) {
    await client.session.switchModel({ sessionID: brainSessionID, model: { providerID, id } });
  }
  brainModelUsed = { providerID, id };
  return brainModelUsed;
}

export async function ensureBrainSession(directory) {
  const { client } = await ensureClient();
  if (brainSessionID) return brainSessionID;
  const m = wantedBrainModel();
  const session = await client.session.create({ agent: "build", model: m, location: { directory } });
  brainSessionID = session.id;
  brainModelUsed = m;
  return brainSessionID;
}

async function runBrainTurn(sessionID, text, onDelta, timeoutMs = 90000, files) {
  const { client } = await ensureClient();
  return new Promise(async (resolve, reject) => {
    const sub = client.event.subscribe();
    let full = "";
    const timer = setTimeout(() => resolve({ status: "timeout", text: full }), timeoutMs);
    (async () => {
      for await (const ev of sub) {
        const d = ev.data ?? {};
        if (d.sessionID !== sessionID) continue;
        if (ev.type === "session.text.delta" && d.delta) {
          const chunk = typeof d.delta === "string" ? d.delta : d.delta.text ?? "";
          full += chunk;
          if (onDelta) onDelta(chunk);
        }
        if (ev.type === "session.execution.succeeded") {
          clearTimeout(timer);
          if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
          resolve({ status: "ok", text: full });
          break;
        }
        if (ev.type === "session.execution.failed") {
          clearTimeout(timer);
          if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
          resolve({ status: "failed", text: full, error: d.error });
          break;
        }
      }
    })().catch(reject);
    try {
      await client.session.prompt(files?.length ? { sessionID, text, files } : { sessionID, text });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

const BrainState = Annotation.Root({
  text: Annotation({ reducer: (_a, b) => b, default: () => "" }),
  files: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  memories: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  reply: Annotation({ reducer: (_a, b) => b, default: () => "" }),
  status: Annotation({ reducer: (_a, b) => b, default: () => "ok" }),
  facts: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  dispatches: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  warnings: Annotation({ reducer: (_a, b) => b, default: () => [] }),
});

// Act convention: think may emit single-line ```dispatch {"task": "...", "agent": "optional-id"}```
// fences, one per task. Single-line only, so the streamer can hold them back and
// the transcript stays readable. Only this shape executes; everything else is
// words. Malformed fences are ignored with a warning, never executed.
const DISPATCH_RE = /^```dispatch\s+(.+?)\s*```[ \t]*$/gm;
const DISPATCH_LINE = /^\s*```dispatch\s+\{.*\}\s*```\s*$/;

export function parseDispatches(reply) {
  const out = [];
  const warnings = [];
  for (const m of String(reply ?? "").matchAll(DISPATCH_RE)) {
    let spec;
    try {
      spec = JSON.parse(m[1].trim());
    } catch {
      warnings.push(`ignoring malformed dispatch fence: ${m[1].trim().slice(0, 80)}`);
      continue;
    }
    const task = String(spec?.task ?? "").trim();
    if (!task || task.length > 2000 || task.includes("\n")) {
      warnings.push(`ignoring dispatch with bad task (empty, multiline, or >2000 chars)`);
      continue;
    }
    const agent = spec?.agent == null ? null : String(spec.agent).trim().toLowerCase();
    if (agent && !/^[a-z0-9-]{1,48}$/.test(agent)) {
      warnings.push(`ignoring dispatch with bad agent id: ${JSON.stringify(spec.agent)}`);
      continue;
    }
    if (spec && typeof spec === "object" && Object.keys(spec).some((k) => k !== "task" && k !== "agent")) {
      warnings.push(`ignoring dispatch with extra keys: ${Object.keys(spec).join(",")}`);
      continue;
    }
    out.push({ task, agent });
  }
  return { dispatches: out, warnings };
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

export function buildThinkPrompt(text, memories, registry) {
  const memLine = memories.length > 0
    ? `What you remember about the user:\n- ${memories.join("\n- ")}\n` : "";
  const fleetLine = (registry ?? []).length > 0
    ? `Fleet agents you can delegate to: ${(registry ?? []).map((a) => `${a.id}${a.description ? ` (${a.description.slice(0, 80)})` : ""}`).join("; ")}. Omit "agent" to let routing decide.\n`
    : `No fleet agents exist yet; do not emit dispatch fences, say what you need instead.\n`;
  return `You are Jarvis, a concise voice-and-text assistant that can delegate work to a fleet of subagents. ${memLine}${fleetLine}When the user asks you to DO something (run, check, review, look at, create, find), you cannot act directly — you MUST delegate with a fence or the task is dropped. Reply briefly in your own voice AND append one single-line fence per task (no newlines inside the JSON):\n\`\`\`dispatch {"task": "<self-contained instruction>", "agent": "<optional id>"}\`\`\`\nKeep the visible reply to one or two sentences. Never put anything but {"task", "agent?"} in a fence. User: ${text}`;
}

function buildGraph(handlers) {
  const g = new StateGraph(BrainState);
  g.addNode("recall", async (state) => {
    const mem = loadMemory();
    return { memories: (await recall(mem, state.text)).map((f) => f.text) };
  });
  g.addNode("think", async (state) => {
    const { client } = await ensureClient();
    const registry = await getFleetRegistry(client, process.cwd()).catch(() => []);
    const prompt = buildThinkPrompt(state.text, state.memories, registry);
    const sessionID = await ensureBrainSession(process.cwd());
    const filter = fencedFilter((d) => handlers.onDelta?.(d));
    let r = await runBrainTurn(sessionID, prompt, (d) => filter.push(d), 90000, state.files);
    if (r.status === "failed" && /quota|rate-limit|429/i.test(JSON.stringify(r.error ?? ""))) {
      const { client: c2 } = await ensureClient();
      const s2 = await c2.session.create({ agent: "build", model: JARVIS_FALLBACK_MODEL, location: { directory: process.cwd() } });
      brainSessionID = s2.id;
      brainModelUsed = JARVIS_FALLBACK_MODEL;
      r = await runBrainTurn(s2.id, prompt, (d) => filter.push(d), 90000, state.files);
    }
    filter.flush();
    return { reply: r.text, status: r.status };
  });
  g.addNode("act", async (state) => {
    // Parse only; execution belongs to main (shared dispatchTask), which owns
    // autoroute + bootstrap gate + spawn + deck broadcast. Displayed reply drops
    // the fences so the transcript stays readable.
    if (state.status !== "ok") return { dispatches: [], warnings: [] };
    const { dispatches, warnings } = parseDispatches(state.reply);
    return { reply: stripDispatches(state.reply), dispatches, warnings };
  });
  g.addNode("persist", async (state) => {
    const mem = loadMemory();
    const saved = [];
    for (const c of extractCandidates(state.text)) {
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
export async function brainRespond(text, onDelta, opts = {}) {
  compiled = buildGraph({ onDelta });
  const out = await compiled.invoke({ text, files: opts.files ?? [] });
  compiled = null;
  return { reply: out.reply, status: out.status ?? "ok", modelUsed: brainModelUsed, memoriesUsed: out.memories ?? [], facts: out.facts ?? [], dispatches: out.dispatches ?? [], warnings: out.warnings ?? [] };
}
