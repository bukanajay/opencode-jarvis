// Jarvis brain: LangGraph loop, OpenCode session as the reasoner.
// Nodes: recall → think → persist. Luna default, switchable via the OpenCode
// model list (JARVIS_BRAIN_MODEL or setBrainModel). No new provider keys.
import { StateGraph, Annotation } from "@langchain/langgraph";
import fs from "node:fs";
import path from "node:path";
import { ensureClient } from "../service.js";
import { JARVIS_MODEL, JARVIS_FALLBACK_MODEL, parseModelRef } from "../sessions.js";
import { loadMemory, remember, recall, extractCandidates } from "./memory.js";

let brainSessionID = null;
let brainModelUsed = null;
let compiled = null;

function wantedBrainModel() {
  return parseModelRef(process.env.JARVIS_BRAIN_MODEL) ?? loadMemory().preferences.brainModel ?? JARVIS_MODEL;
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
});

function buildGraph(handlers) {
  const g = new StateGraph(BrainState);
  g.addNode("recall", async (state) => {
    const mem = loadMemory();
    return { memories: (await recall(mem, state.text)).map((f) => f.text) };
  });
  g.addNode("think", async (state) => {
    const memLine = state.memories.length > 0
      ? `What you remember about the user:\n- ${state.memories.join("\n- ")}\n` : "";
    const prompt = `You are Jarvis, a concise voice-and-text assistant. ${memLine}User: ${state.text}`;
    const sessionID = await ensureBrainSession(process.cwd());
    let r = await runBrainTurn(sessionID, prompt, handlers.onDelta, 90000, state.files);
    if (r.status === "failed" && /quota|rate-limit|429/i.test(JSON.stringify(r.error ?? ""))) {
      const { client } = await ensureClient();
      const s2 = await client.session.create({ agent: "build", model: JARVIS_FALLBACK_MODEL, location: { directory: process.cwd() } });
      brainSessionID = s2.id;
      brainModelUsed = JARVIS_FALLBACK_MODEL;
      r = await runBrainTurn(s2.id, prompt, handlers.onDelta, 90000, state.files);
    }
    return { reply: r.text, status: r.status };
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
  g.addEdge("think", "persist");
  g.addEdge("persist", "__end__");
  return g.compile();
}

// One brain turn: memory in, streamed reply out, facts persisted.
export async function brainRespond(text, onDelta, opts = {}) {
  compiled = buildGraph({ onDelta });
  const out = await compiled.invoke({ text, files: opts.files ?? [] });
  compiled = null;
  return { reply: out.reply, status: out.status ?? "ok", modelUsed: brainModelUsed, memoriesUsed: out.memories ?? [], facts: out.facts ?? [] };
}
