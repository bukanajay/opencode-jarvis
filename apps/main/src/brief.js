// The brief: what a chief of staff tells you first thing (or whenever you
// ask "what did I miss?"). Facts are gathered here, deterministically and
// locally (git across recent projects, the fleet, the decision inbox,
// routines); the brain turns them into a short spoken-friendly brief and may
// add what its read-only tools can see (e.g. cloud cost via MCP).
import { execFile } from "node:child_process";

function git(dir, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { timeout }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Per project: branch, commits since `sinceMs`, uncommitted file count.
export async function gitActivity(projects, sinceMs) {
  const since = new Date(sinceMs).toISOString();
  const out = [];
  for (const p of projects.slice(0, 6)) {
    const branch = (await git(p.dir, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
    if (!branch) continue; // not a git repo
    const log = (await git(p.dir, ["log", `--since=${since}`, "--pretty=format:%h %an: %s", "-n", "15", "--all"])) ?? "";
    const status = (await git(p.dir, ["status", "--porcelain"])) ?? "";
    out.push({
      name: p.name,
      branch,
      commits: log.split("\n").filter(Boolean),
      uncommitted: status.split("\n").filter(Boolean).length,
    });
  }
  return out;
}

export function briefFacts({ now = Date.now(), userName = "", sinceMs, git = [], workers = [], inbox = [], routinesLine = "" } = {}) {
  const lines = [];
  const when = new Date(now);
  lines.push(`Now: ${when.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}. Covering since ${new Date(sinceMs).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit" })}.`);
  if (userName) lines.push(`User: ${userName}.`);
  if (inbox.length) {
    lines.push(`Waiting on the user (${inbox.length}):`);
    for (const i of inbox.slice(0, 8)) lines.push(`- ${i.title}${i.detail ? ` — ${i.detail}` : ""}`);
  } else {
    lines.push("Waiting on the user: nothing.");
  }
  const byState = (s) => workers.filter((w) => w.state === s);
  const done = byState("done");
  const failed = byState("failed");
  const running = workers.filter((w) => ["working", "permission"].includes(w.state));
  lines.push(`Fleet: ${running.length} running, ${done.length} finished, ${failed.length} failed.`);
  for (const w of [...failed, ...done].slice(0, 6)) lines.push(`- ${w.state}: ${String(w.task ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
  for (const g of git) {
    lines.push(`Project ${g.name} (${g.branch}): ${g.commits.length} commit(s) since then${g.uncommitted ? `, ${g.uncommitted} uncommitted file(s)` : ""}.`);
    for (const c of g.commits.slice(0, 5)) lines.push(`  - ${c}`);
  }
  if (routinesLine) lines.push(routinesLine);
  return lines.join("\n");
}

export function briefPrompt(facts, { userName = "" } = {}) {
  return `Give ${userName || "the user"} their brief as their chief of staff. Facts gathered just now:\n${facts}\n\n` +
    `You may use your read-only tools to add anything important that changed (for example cloud cost or service health, if you have those tools); do not dispatch workers for the brief. ` +
    `Format: one-line headline; "Needs you" (decisions waiting, most urgent first); "What changed"; "Today" (one or two suggested priorities). ` +
    `Under 150 words, plain and direct, no filler. If nothing needs them, say so.`;
}

// "good morning", "brief me", "what did I miss" -> run the brief locally.
export function isBriefRequest(text) {
  const t = String(text ?? "").toLowerCase().replace(/[.!?,]+/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:good morning(?: jarvis)?|morning jarvis|brief me(?: now)?|give me (?:my|the|a) (?:morning )?brief(?:ing)?|(?:what's|what is) my brief(?:ing)?|what did i miss|catch me up|morning brief(?:ing)?|daily brief(?:ing)?)$/.test(t);
}
