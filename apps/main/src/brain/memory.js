// Long-term memory: local JSON, no server involved. Facts are short durable
// strings ("user prefers amber", "reviewer agent exists"). Two stores: global
// (about the user) and per project (conventions, commands, architecture);
// recallAll searches both, project facts first. Recall is
// embedding-first (local MiniLM) with BM25 fallback; only LLM fact
// extraction remains a later slice.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectDir, projectStateDir } from "../project.js";

const STOP = new Set("a,an,the,is,are,was,were,my,i,you,your,it,its,to,of,in,on,for,and,or,that,this,me,please".split(","));
const MAX_FACTS = 200;

export function memoryPath() {
  if (process.env.JARVIS_MEMORY_FILE) return process.env.JARVIS_MEMORY_FILE;
  return path.join(os.homedir(), ".config", "jarvis", "memory.json");
}

export function loadMemory(file = memoryPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const facts = Array.isArray(raw.facts) ? raw.facts : [];
    const seen = new Set();
    const deduped = facts.filter((f) => {
      if (!f?.id || seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
    const vectors = raw.vectors && typeof raw.vectors === "object" ? raw.vectors : {};
    for (const k of Object.keys(vectors)) if (!seen.has(k)) delete vectors[k];
    return { file, facts: deduped, preferences: raw.preferences ?? {}, vectors };
  } catch {
    return { file, facts: [], preferences: {}, vectors: {} };
  }
}

export function projectMemoryPath(dir = projectDir()) {
  return path.join(projectStateDir(dir), "memory.json");
}

export function loadProjectMemory(dir = projectDir()) {
  return loadMemory(projectMemoryPath(dir));
}

export function saveMemory(mem) {
  save(mem);
}

function save(mem) {
  fs.mkdirSync(path.dirname(mem.file), { recursive: true });
  fs.writeFileSync(mem.file, JSON.stringify({ facts: mem.facts, preferences: mem.preferences, vectors: mem.vectors ?? {} }, null, 2));
}

function words(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
}

export function remember(mem, text, tags = []) {
  const clean = String(text ?? "").trim().slice(0, 280);
  if (!clean) throw new Error("remember: text required");
  if (mem.facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) return null;
  const fact = { id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, text: clean, at: Date.now(), tags };
  mem.facts.push(fact);
  while (mem.facts.length > MAX_FACTS) mem.facts.shift();
  save(mem);
  return fact;
}

export function forget(mem, id) {
  const n = mem.facts.length;
  mem.facts = mem.facts.filter((f) => f.id !== id);
  if (mem.vectors) delete mem.vectors[id];
  if (mem.facts.length !== n) save(mem);
  return n !== mem.facts.length;
}

// "forget that I prefer tabs": the facts whose text best matches the phrase.
// Exact (case-insensitive) match wins, then containment either way, then
// shared-word overlap; returns all ties so callers can refuse ambiguity.
export function matchFacts(mem, phrase) {
  const want = String(phrase ?? "").trim().toLowerCase();
  if (!want) return [];
  const exact = mem.facts.filter((f) => f.text.toLowerCase() === want);
  if (exact.length) return exact;
  const contains = mem.facts.filter((f) => f.text.toLowerCase().includes(want) || want.includes(f.text.toLowerCase()));
  if (contains.length) return contains;
  const ws = new Set(words(want));
  if (!ws.size) return [];
  let best = 0;
  let hits = [];
  for (const f of mem.facts) {
    const fw = new Set(words(f.text));
    const overlap = [...ws].filter((w) => fw.has(w)).length / Math.max(ws.size, 1);
    if (overlap > best) { best = overlap; hits = [f]; } else if (overlap === best && overlap > 0) hits.push(f);
  }
  return best >= 0.6 ? hits : [];
}

export function recall(mem, query, limit = 5) {
  return recallSemantic(mem, query, limit);
}

// Local embedding provider (Transformers.js MiniLM, ONNX CPU, no keys, no
// network after first model download). Cosine rank; anything below the floor
// or any provider failure falls back to BM25. JARVIS_EMBED_OFF=1 forces BM25.
const EMBED_FLOOR = 0.28;
let embedder = null;

async function getEmbedder() {
  if (process.env.JARVIS_EMBED_OFF === "1") throw new Error("embeddings off");
  if (!embedder) {
    const { pipeline } = await import("@xenova/transformers");
    embedder = await pipeline("feature-extraction", process.env.JARVIS_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2");
  }
  return embedder;
}

export function warmEmbeddings() {
  getEmbedder().catch(() => {});
}

async function embedRows(texts) {
  const ex = await getEmbedder();
  const out = await ex(texts, { pooling: "mean", normalize: true });
  const rows = out.tolist();
  return Array.isArray(rows[0]) ? rows : [rows];
}

async function ensureVectors(mem) {
  mem.vectors ??= {};
  const missing = mem.facts.filter((f) => !Array.isArray(mem.vectors[f.id]));
  if (missing.length === 0) return;
  const rows = await embedRows(missing.map((f) => f.text));
  missing.forEach((f, i) => { mem.vectors[f.id] = rows[i]; });
  save(mem);
}

const dot = (a, b) => a.reduce((n, x, i) => n + x * (b[i] ?? 0), 0);

export async function recallSemantic(mem, query, limit = 5) {
  try {
    if (!String(query ?? "").trim() || mem.facts.length === 0) return [];
    await ensureVectors(mem);
    const [qvec] = await embedRows([String(query)]);
    const ranked = mem.facts
      .map((f) => ({ fact: f, score: dot(qvec, mem.vectors[f.id] ?? []) }))
      .filter((r) => r.score >= EMBED_FLOOR)
      .sort((a, b) => b.score - a.score || b.fact.at - a.fact.at);
    return ranked.slice(0, limit).map((r) => r.fact);
  } catch {
    return bm25Recall(mem, query, limit);
  }
}

// Project facts first (they are the most specific), then global ones, no
// duplicates, capped at limit overall.
export async function recallAll(query, limit = 6, dir = projectDir()) {
  const [proj, glob] = await Promise.all([
    recallSemantic(loadProjectMemory(dir), query, limit).catch(() => []),
    recallSemantic(loadMemory(), query, limit).catch(() => []),
  ]);
  const seen = new Set();
  return [...proj, ...glob].filter((f) => {
    const k = f.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, limit);
}

// BM25-lite: idf-weighted overlap with length norm. Sync fallback when the
// local embedding provider is off or unavailable. No deps, no embeddings.
export function bm25Recall(mem, query, limit = 5) {
  const q = words(query);
  if (q.length === 0) return [];
  const docs = mem.facts.map((f) => words(f.text));
  // BM25-lite: idf-weighted overlap with length norm. No deps, no embeddings.
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = Math.max(docs.length, 1);
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / N || 1;
  return mem.facts
    .map((f, i) => {
      const d = docs[i];
      let score = 0;
      for (const w of new Set(q)) {
        const tf = d.filter((x) => x === w).length;
        if (!tf) continue;
        const idf = Math.log(1 + N / (df.get(w) ?? N));
        score += idf * (tf / (tf + 0.75 * (0.25 + 0.75 * (d.length / avgLen))));
      }
      return { fact: f, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.at - a.fact.at)
    .slice(0, limit)
    .map((r) => r.fact);
}

// Explicitly project-scoped facts: "remember for this project that …",
// "remember in this repo …", "for this project, remember …".
export function extractProjectCandidates(text) {
  const t = String(text ?? "");
  let m;
  if ((m = t.match(/remember (?:for|in) this (?:project|repo|codebase)(?: that|:|,)?\s+(.{3,200})/i))) return [m[1].trim()];
  if ((m = t.match(/(?:for|in) this (?:project|repo|codebase),? remember (?:that )?(.{3,200})/i))) return [m[1].trim()];
  return [];
}

// Heuristic durable-fact extraction. No model call; LLM extraction is a later slice.
export function extractCandidates(text) {
  const out = [];
  const t = String(text ?? "");
  let m;
  if ((m = t.match(/remember (?:that )?(.{3,200})/i))) out.push(m[1].trim());
  if ((m = t.match(/\bmy ([\w -]{2,40}?) is ([\w -]{2,60})/i))) out.push(`user's ${m[1].trim()} is ${m[2].trim()}`);
  if ((m = t.match(/\bi prefer ([\w -]{2,80})/i))) out.push(`user prefers ${m[1].trim()}`);
  return [...new Set(out)];
}
