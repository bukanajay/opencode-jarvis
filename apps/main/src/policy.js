// Autonomy policy: which worker requests Jarvis answers on its own.
//
// Every permission a worker asks for is classified into an action class
// (read, web, edit, safe command, command, external read/write, deploy,
// spend, destructive, outside the workspace). Each class is auto / ask /
// never. Deploy, spend and destructive can never be auto: the user always
// decides those. Explicit rules ("always allow `npm test`") come from the
// user, usually offered after they approved the same thing three times.
// Pure: Main persists the store and executes the decision.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLASSES = {
  read: "Read files and search the project",
  web: "Fetch web pages and search the web",
  edit: "Edit files (in the worker's own worktree when isolation is on)",
  "run-safe": "Read-only and test commands (git status, ls, npm test, …)",
  run: "Other shell commands",
  "external-read": "Read from connected systems (GitHub, Linear, Stripe, …)",
  "external-write": "Write to connected systems (comment, create, send, update)",
  outside: "Touch files outside the project",
  deploy: "Push, publish, deploy, change cloud infrastructure",
  spend: "Move money (charges, refunds, payouts, purchases)",
  destructive: "Delete or overwrite irreversibly (rm -rf, force push, drop)",
};
export const MODES = ["auto", "ask", "never"];
export const NEVER_AUTO = new Set(["deploy", "spend", "destructive"]);

export const PRESETS = {
  cautious: { read: "auto", web: "ask", edit: "ask", "run-safe": "ask", run: "ask", "external-read": "ask", "external-write": "ask", outside: "ask", deploy: "ask", spend: "ask", destructive: "ask" },
  balanced: { read: "auto", web: "auto", edit: "auto", "run-safe": "auto", run: "ask", "external-read": "auto", "external-write": "ask", outside: "ask", deploy: "ask", spend: "ask", destructive: "ask" },
  "hands-off": { read: "auto", web: "auto", edit: "auto", "run-safe": "auto", run: "auto", "external-read": "auto", "external-write": "ask", outside: "ask", deploy: "ask", spend: "ask", destructive: "ask" },
};
export const DAILY_AUTO_CAP = 300;
export const LEARN_AFTER = 3;

// Worker sessions are created with these rules so every non-read request
// reaches Jarvis (which answers routine ones itself in milliseconds) instead
// of the agent's defaults silently allowing shell commands. Later rules win.
export const WORKER_SESSION_RULES = [
  { action: "*", resource: "*", effect: "ask" },
  ...["read", "grep", "glob", "list", "todowrite", "todoread", "task"].map((action) => ({ action, resource: "*", effect: "allow" })),
];

// ---- classification ------------------------------------------------------

const SAFE_CMD = [
  /^(ls|ll|pwd|cat|head|tail|wc|file|stat|du|df|tree|which|whoami|date|uname|env|printenv|echo)(\s|$)/,
  /^command\s+-v\s/,
  /^type\s+\S+$/,
  /^(rg|grep|egrep|fgrep|ag)\s/,
  /^find\s(?!.*(-delete|-exec|-ok\b|-fprint))/,
  /^git\s+(status|log|diff|show|branch|remote\s+-v|rev-parse|ls-files|blame|describe|tag\s*$|stash\s+list|config\s+--get)(\s|$)/,
  /^(node|npm|npx|pnpm|yarn|bun|deno|python3?|pip3?|go|cargo|rustc|java|ruby|swift|swiftc|xcodebuild|docker|kubectl|terraform|aws|gh)\s+(--version|-v|version)$/,
  /^(npm|pnpm|yarn|bun)\s+(test|run\s+(test|check|lint|typecheck|build)|ls|outdated|audit(?!\s+fix))(\s|$)/,
  /^(pytest|jest|vitest|mocha|go\s+test|go\s+vet|cargo\s+(test|check|clippy)|swift\s+test|make\s+(test|check|lint))(\s|$)/,
  /^node\s+--test(\s|$)/,
  /^node\s+scripts\/(check-syntax|prove-[\w-]+|eval-brain)\.mjs(\s|$)/,
  /^(tsc|eslint|prettier\s+--check|ruff|mypy|flake8|black\s+--check)(\s|$)/,
];
const DESTRUCTIVE_CMD = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, /\bgit\s+push\s+.*(--force|-f\b|--force-with-lease)/, /\bgit\s+reset\s+--hard/, /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+branch\s+-D\b/, /\bgit\s+checkout\s+--\s+\./, /\b(drop|truncate)\s+(table|database|schema)\b/i, /\bmkfs\b|\bdd\s+if=/, /\bchmod\s+-R\b|\bchown\s+-R\b/,
  /\bsudo\b/, /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, /\bkill(all)?\s+-9\b/, /:\(\)\s*\{/, />\s*\/dev\/(sd|disk)/, /\bshred\b/, /\bdiskutil\s+erase/,
];
const DEPLOY_CMD = [
  /\bgit\s+push\b/, /\b(npm|pnpm|yarn)\s+publish\b/, /\bdocker\s+push\b/, /\bkubectl\s+(apply|delete|rollout|scale|patch|create|replace)\b/,
  /\bterraform\s+(apply|destroy|import)\b/, /\bpulumi\s+(up|destroy)\b/, /\bcdk\s+(deploy|destroy)\b/, /\bsam\s+deploy\b/, /\bserverless\s+deploy\b/,
  /\baws\s+\S+\s+(create|delete|put|update|terminate|run-instances|modify|attach|detach|start|stop|reboot|deregister|register)[\w-]*/, /\bgcloud\b.*\b(deploy|create|delete)\b/,
  /\bgh\s+(release\s+create|pr\s+merge|repo\s+delete)\b/, /\b(vercel|netlify)\b.*--prod\b/, /\bfly(ctl)?\s+deploy\b/, /\bheroku\s+.*(deploy|releases)/, /\beas\s+(submit|update)\b/,
];
// Money moves: refund/payout/transfer/capture/purchase/pay, or creating /
// confirming a charge, payment or invoice ("list_charges" is only a read).
const SPEND_WORDS = /(refund|payout|transfer|capture|purchase|(^|[^a-z])pay(_|$)|(create|confirm|finali[sz]e|send)_?(charge|payment|invoice))/i;
const WRITE_WORDS = /(create|update|delete|remove|send|post|reply|comment|merge|close|reopen|assign|label|invite|archive|move|edit|write|publish|cancel|approve|dismiss|upload|set_|add_)/i;
const DESTRUCTIVE_TOOL = /(delete|remove|destroy|drop|purge|wipe)/i;

// Split a shell command into its pipeline / chain segments.
export function commandSegments(cmd) {
  return String(cmd ?? "").split(/\s*(?:&&|\|\||;|\|(?!\|))\s*/).map((s) => s.trim()).filter(Boolean);
}

export function classifyCommand(cmd) {
  const c = String(cmd ?? "").trim();
  if (!c) return "run";
  if (DESTRUCTIVE_CMD.some((r) => r.test(c))) return "destructive";
  if (DEPLOY_CMD.some((r) => r.test(c))) return "deploy";
  if (/[^>]>[^>&]|>>|\btee\b/.test(` ${c}`)) return "run"; // writes files via redirection
  const segs = commandSegments(c);
  return segs.length && segs.every((s) => SAFE_CMD.some((r) => r.test(s))) ? "run-safe" : "run";
}

const isBash = (a) => /^(bash|shell|exec|command|run|terminal)$/i.test(a);
const isRead = (a) => /^(read|grep|glob|list|ls|search|codesearch|lsp)$/i.test(a);
const isWeb = (a) => /^(webfetch|websearch|fetch|web)$/i.test(a);
const isEdit = (a) => /^(edit|write|patch|multiedit|apply_patch)$/i.test(a);

// request: { action, resources[] }; ctx: { isolated }
export function classify(request) {
  const action = String(request?.action ?? "").trim();
  const resources = (request?.resources ?? []).map(String);
  const what = resources.join(" ").trim();
  let cls;
  if (isBash(action)) cls = resources.length ? resources.map(classifyCommand).reduce(worst, "run-safe") : "run";
  else if (isRead(action)) cls = "read";
  else if (isWeb(action)) cls = "web";
  else if (isEdit(action)) cls = "edit";
  else if (/external_directory|outside/i.test(action)) cls = "outside";
  else if (/^task$|^todo/i.test(action)) cls = "read";
  else if (/[_.:-]/.test(action) || /^jarvis-/.test(action)) {
    // MCP tool from a connector or your own servers: verb decides.
    if (SPEND_WORDS.test(action)) cls = "spend";
    else if (DESTRUCTIVE_TOOL.test(action)) cls = "destructive";
    else if (WRITE_WORDS.test(action)) cls = "external-write";
    else cls = "external-read";
  } else cls = "run";
  return { class: cls, action, what, signature: signature(action, resources, cls) };
}

const RANK = ["read", "web", "external-read", "run-safe", "edit", "outside", "run", "external-write", "deploy", "spend", "destructive"];
function worst(a, b) { return RANK.indexOf(b) > RANK.indexOf(a) ? b : a; }

// What "the same request" means for learning: action plus the command's
// first two words (npm test, git commit) or the file's directory.
export function signature(action, resources, cls) {
  const first = String(resources?.[0] ?? "").trim();
  if (isBash(action)) {
    const words = first.split(/\s+/).filter(Boolean);
    const head = words[0] === "npm" || words[0] === "pnpm" || words[0] === "yarn" || words[0] === "git" || words[0] === "node" || words[0] === "npx" ? words.slice(0, 2) : words.slice(0, 1);
    return `${action}:${head.join(" ")}`;
  }
  if (cls === "edit" || cls === "outside" || cls === "read") return `${action}:${path.dirname(first || ".")}`;
  return `${action}:${first.slice(0, 60)}`;
}

// ---- decisions ------------------------------------------------------------

// store: { enabled, preset, classes, rules, stats, dismissed, daily }
// ctx: { isolated, today }
export function decide(request, store, ctx = {}) {
  const c = classify(request);
  const base = { ...c, isolated: !!ctx.isolated };
  if (!store?.enabled) return { ...base, decision: "ask", reason: "autonomy is off" };
  const rule = (store.rules ?? []).find((r) => ruleMatches(r, request, c));
  if (rule) {
    if (rule.decision === "deny") return { ...base, decision: "deny", reason: `your rule: never ${rule.label}`, rule: rule.id };
    if (NEVER_AUTO.has(c.class)) return { ...base, decision: "ask", reason: `${c.class} always needs you, even with a rule` };
    return capped(store, ctx, { ...base, decision: "allow", reason: `your rule: always ${rule.label}`, rule: rule.id });
  }
  let mode = effectiveMode(store, c.class);
  if (c.class === "edit" && !ctx.isolated && mode === "auto") mode = "ask"; // auto edits only inside a worktree
  if (NEVER_AUTO.has(c.class) && mode === "auto") mode = "ask";
  if (mode === "never") return { ...base, decision: "deny", reason: `policy: ${c.class} is set to never` };
  if (mode === "auto") return capped(store, ctx, { ...base, decision: "allow", reason: `policy: ${c.class} is auto` });
  return { ...base, decision: "ask", reason: `policy: ${c.class} asks you` };
}

function capped(store, ctx, d) {
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const n = store.daily?.date === today ? store.daily.n : 0;
  if (n >= (store.dailyCap ?? DAILY_AUTO_CAP)) return { ...d, decision: "ask", reason: `daily auto-approval cap (${store.dailyCap ?? DAILY_AUTO_CAP}) reached` };
  return d;
}

export function effectiveMode(store, cls) {
  const preset = PRESETS[store?.preset] ?? PRESETS.balanced;
  const m = store?.classes?.[cls] ?? preset[cls] ?? "ask";
  return NEVER_AUTO.has(cls) && m === "auto" ? "ask" : m;
}

export function ruleMatches(rule, request, c = classify(request)) {
  if (rule.action && rule.action !== c.action) return false;
  if (rule.signature) return rule.signature === c.signature;
  return false;
}

export function makeRule(c, decision = "allow", now = Date.now()) {
  const label = c.signature.replace(/^[^:]+:/, "") || c.action;
  return { id: `rule_${now.toString(36)}`, action: c.action, signature: c.signature, decision, label: `${c.action} \`${label}\``, class: c.class, createdAt: now, uses: 0 };
}

// After the user answers: update stats; return a suggestion when the same
// request was approved LEARN_AFTER times with no denials (and can be auto).
export function learn(store, c, userDecision, now = Date.now()) {
  store.stats ??= {};
  const s = (store.stats[c.signature] ??= { allow: 0, deny: 0, class: c.class, action: c.action, last: 0 });
  s[userDecision === "allow" ? "allow" : "deny"] += 1;
  s.last = now;
  const already = (store.rules ?? []).some((r) => r.signature === c.signature) || (store.dismissed ?? []).includes(c.signature);
  if (userDecision === "allow" && s.allow >= LEARN_AFTER && s.deny === 0 && !NEVER_AUTO.has(c.class) && !already && effectiveMode(store, c.class) !== "auto") {
    return { signature: c.signature, class: c.class, action: c.action, label: makeRule(c).label, count: s.allow };
  }
  return null;
}

// ---- store ----------------------------------------------------------------

export function policyPath() {
  return process.env.JARVIS_AUTONOMY_FILE ?? path.join(os.homedir(), ".config", "jarvis", "autonomy.json");
}

export function loadPolicy(file = policyPath()) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch {}
  return { enabled: true, preset: "balanced", classes: {}, rules: [], stats: {}, dismissed: [], suggestions: [], daily: null, dailyCap: DAILY_AUTO_CAP, ...raw, file };
}

export function savePolicy(store) {
  const { file, ...data } = store;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function countAuto(store, today = new Date().toISOString().slice(0, 10)) {
  store.daily = store.daily?.date === today ? { date: today, n: store.daily.n + 1 } : { date: today, n: 1 };
}

// Tightening is always allowed; loosening (to auto, a looser preset, or
// turning autonomy on) only from the user's own hands in the UI.
const LOOSENESS = { never: 0, ask: 1, auto: 2 };
const PRESET_ORDER = ["cautious", "balanced", "hands-off"];
export function isTightening(store, change) {
  if (change.op === "pause") return true;
  if (change.op === "resume") return false;
  if (change.op === "preset") return PRESET_ORDER.indexOf(change.preset) <= PRESET_ORDER.indexOf(store.preset ?? "balanced");
  if (change.op === "class") return LOOSENESS[change.mode] <= LOOSENESS[effectiveMode(store, change.class)];
  return false;
}

export function autonomySummary(store, today = new Date().toISOString().slice(0, 10)) {
  if (!store.enabled) return "Autonomy: paused (every worker request asks the user).";
  const auto = Object.keys(CLASSES).filter((k) => effectiveMode(store, k) === "auto");
  const never = Object.keys(CLASSES).filter((k) => effectiveMode(store, k) === "never");
  const n = store.daily?.date === today ? store.daily.n : 0;
  return `Autonomy: ${store.preset} preset; auto: ${auto.join(", ") || "nothing"}${never.length ? `; never: ${never.join(", ")}` : ""}; ${store.rules.length} rule(s); ${n} auto-approval(s) today. Deploy, spend and destructive always ask the user.`;
}

// Decision log for the deck and audits.
export function decisionsPath() {
  return process.env.JARVIS_DECISIONS_FILE ?? path.join(os.homedir(), ".config", "jarvis", "decisions.jsonl");
}
export function logDecision(entry, file = decisionsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
}
export function recentDecisions(n = 20, file = decisionsPath()) {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").slice(-n).map((l) => JSON.parse(l)).reverse();
  } catch { return []; }
}
