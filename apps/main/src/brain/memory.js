// Long-term memory: local JSON, no server involved. Facts are short durable
// strings ("user prefers amber", "reviewer agent exists"). Recall is keyword
// overlap — good enough for core; embeddings are a later slice.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STOP = new Set("a,an,the,is,are,was,were,my,i,you,your,it,its,to,of,in,on,for,and,or,that,this,me,please".split(","));
const MAX_FACTS = 200;

export function memoryPath() {
  if (process.env.JARVIS_MEMORY_FILE) return process.env.JARVIS_MEMORY_FILE;
  return path.join(os.homedir(), ".config", "jarvis", "memory.json");
}

export function loadMemory(file = memoryPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, facts: Array.isArray(raw.facts) ? raw.facts : [], preferences: raw.preferences ?? {} };
  } catch {
    return { file, facts: [], preferences: {} };
  }
}

function save(mem) {
  fs.mkdirSync(path.dirname(mem.file), { recursive: true });
  fs.writeFileSync(mem.file, JSON.stringify({ facts: mem.facts, preferences: mem.preferences }, null, 2));
}

function words(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
}

export function remember(mem, text, tags = []) {
  const clean = String(text ?? "").trim().slice(0, 280);
  if (!clean) throw new Error("remember: text required");
  if (mem.facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) return null;
  const fact = { id: `mem_${Date.now().toString(36)}`, text: clean, at: Date.now(), tags };
  mem.facts.push(fact);
  while (mem.facts.length > MAX_FACTS) mem.facts.shift();
  save(mem);
  return fact;
}

export function forget(mem, id) {
  const n = mem.facts.length;
  mem.facts = mem.facts.filter((f) => f.id !== id);
  if (mem.facts.length !== n) save(mem);
  return n !== mem.facts.length;
}

export function recall(mem, query, limit = 5) {
  const q = new Set(words(query));
  if (q.size === 0) return [];
  return mem.facts
    .map((f) => ({ fact: f, score: words(f.text).filter((w) => q.has(w)).length }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.at - a.fact.at)
    .slice(0, limit)
    .map((r) => r.fact);
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
