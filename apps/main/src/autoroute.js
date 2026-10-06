// Auto-route: explicit "@agent" mentions + keyword fallback when autoMode is on.
// Pure functions (parseExplicitAgent, pickAgent, resolveAgent) never touch the
// server; getFleetRegistry is the only async helper and owns its own
// agent.list filtering so it never imports the (parallel-slice) bootstrap.
export const BUILTINS = ["build", "plan", "general", "explore", "scout", "compaction", "title", "summary"];

// agent.list minus BUILTINS -> [{id, description}]. Tolerates list/get shapes.
export async function getFleetRegistry(client, directory) {
  const res = await client.agent.list(directory ? { location: { directory } } : undefined);
  const raw = res?.data ?? res?.agents ?? res ?? [];
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .filter((a) => a && !BUILTINS.includes(a.id ?? a.name))
    .map((a) => ({ id: a.id ?? a.name, description: a.description ?? "" }));
}

const ID = "([A-Za-z0-9-]{1,48})";

// Explicit routing. Anchored at the start so plain sentences never match;
// unknown ids are rejected later by resolveAgent, not here.
export function parseExplicitAgent(text) {
  const t = String(text ?? "").trim();
  let m;
  if ((m = t.match(new RegExp(`^@${ID}\\s+(.+)$`, "s")))) return { agent: m[1].toLowerCase(), task: m[2].trim() };
  if ((m = t.match(new RegExp(`^ask\\s+${ID}\\s+to\\s+(.+)$`, "is")))) return { agent: m[1].toLowerCase(), task: m[2].trim() };
  if ((m = t.match(new RegExp(`^using\\s+${ID}\\s+(?:to\\s+)?(.+)$`, "is")))) return { agent: m[1].toLowerCase(), task: m[2].trim() };
  if ((m = t.match(new RegExp(`^with\\s+${ID}\\s+(.+)$`, "is")))) return { agent: m[1].toLowerCase(), task: m[2].trim() };
  return null;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "for", "with", "please", "you", "your",
  "this", "that", "these", "those", "are", "was", "were", "have", "has",
  "will", "would", "could", "should", "from", "into", "over", "under",
  "what", "when", "where", "which", "does", "doing", "about", "there",
  "here", "out", "our", "its", "per", "via", "then", "than", "also",
]);

function words(s) {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

// Task word hits an entry word on exact match or shared stem (either contains
// the other, min length 4) so "review" matches "reviewer"/"reviews".
function hits(taskWord, entryWords) {
  for (const e of entryWords) {
    if (e === taskWord) return true;
    if (taskWord.length >= 4 && e.length >= 4 && (e.includes(taskWord) || taskWord.includes(e))) return true;
  }
  return false;
}

// Deterministic keyword overlap; ties, scoreless fields, and empty
// registries all fall back to defaultAgent.
export function pickAgent(taskText, registry, defaultAgent = "build") {
  const reg = Array.isArray(registry) ? registry : [];
  if (reg.length === 0) return { agent: defaultAgent, reason: `empty->${defaultAgent} (0 hits)` };
  const taskWords = words(taskText);
  let best = null;
  let bestScore = -1;
  let bestTop = "";
  let tied = false;
  for (const entry of reg) {
    const entryWords = words(`${entry.id} ${entry.description ?? ""}`);
    let score = 0;
    let top = "";
    for (const w of taskWords) {
      if (hits(w, entryWords)) {
        score++;
        if (!top) top = w;
      }
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
      bestTop = top;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  if (bestScore <= 0) return { agent: defaultAgent, reason: `none->${defaultAgent} (0 hits)` };
  if (tied) return { agent: defaultAgent, reason: `tie->${defaultAgent} (${bestScore} hits)` };
  return { agent: best.id, reason: `${bestTop}->${best.id} (${bestScore} hits)` };
}

// explicit: null | id string | {agent, task} from parseExplicitAgent.
// Known = registry + BUILTINS + defaultAgent (builtins never list, but "@build" is valid).
export function resolveAgent(taskText, opts = {}) {
  const { explicit = null, defaultAgent = "build", autoMode = "off", registry = [] } = opts;
  if (explicit) {
    const id = (typeof explicit === "string" ? explicit : explicit.agent ?? "").toLowerCase();
    const known = new Set([...(Array.isArray(registry) ? registry : []).map((e) => e.id), ...BUILTINS, defaultAgent]);
    if (!id || !known.has(id)) return { error: `unknown agent: ${JSON.stringify(typeof explicit === "string" ? explicit : explicit.agent)}` };
    return { agent: id };
  }
  if (autoMode === true || autoMode === "on") {
    const picked = pickAgent(taskText, registry, defaultAgent);
    return { agent: picked.agent, reason: picked.reason };
  }
  return { agent: defaultAgent };
}
