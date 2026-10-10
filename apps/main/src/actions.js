// Jarvis's own actions. The brain is read-only (it cannot edit or run
// anything), but it is still the one who runs the deck: settings, the fleet,
// worktree branches, projects. It asks for those with a single-line fence
//   ```jarvis {"action": "...", ...}```
// which Main validates against this allowlist and executes. Work on the code
// or the machine still goes to workers (dispatch). Never here: answering a
// worker's permission request or widening permissions; those stay with the user.
// All pure: parsing, validation and the state the brain is shown.
import { VOICES, FOLLOW_UPS, ACCENTS } from "./shell.js";

export const SETTABLE = [
  "accent", "density", "layout", "captionSize", "wake", "voiceMode", "autoMode", "reviewMode",
  "isolation", "defaultAgent", "jarvisModel", "workerModel", "voice", "followUp", "userName",
];
export const CLEANUP_STATES = ["done", "failed", "stopped"];

const WORKER_REF = /^[A-Za-z0-9_]{4,64}$/;
const ACTION_KEYS = {
  set: ["setting", "value"],
  cleanup: ["states"],
  stop: ["worker"],
  remove: ["worker"],
  followup: ["worker", "task"],
  land: ["chain"],
  keep: ["chain"],
  discard: ["chain"],
  project: ["name"],
  hush: [],
  remember: ["fact", "scope"],
  forget: ["fact", "scope"],
  agent: ["purpose", "name"],
};
export const ACTIONS = Object.keys(ACTION_KEYS);

// Returns { action, ...args } or throws with a reason.
export function validateAction(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("not an object");
  const action = String(spec.action ?? "");
  const keys = ACTION_KEYS[action];
  if (!keys) throw new Error(`unknown action: ${action || "(none)"}`);
  const extra = Object.keys(spec).filter((k) => k !== "action" && !keys.includes(k));
  if (extra.length) throw new Error(`${action}: unexpected ${extra.join(", ")}`);
  const str = (k, max = 200) => {
    const v = spec[k];
    if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\n")) throw new Error(`${action}: bad ${k}`);
    return v.trim();
  };
  const ref = (k) => {
    const v = str(k, 64);
    if (!WORKER_REF.test(v)) throw new Error(`${action}: bad ${k} id`);
    return v;
  };
  switch (action) {
    case "set": {
      const setting = str("setting", 32);
      if (!SETTABLE.includes(setting)) throw new Error(`set: ${setting} is not something Jarvis may change`);
      if (typeof spec.value === "number" || typeof spec.value === "boolean") spec = { ...spec, value: String(spec.value) };
      return { action, setting, value: normalizeValue(setting, str("value", 120)) };
    }
    case "cleanup": {
      const raw = spec.states == null ? CLEANUP_STATES : Array.isArray(spec.states) ? spec.states : [spec.states];
      const states = [...new Set(raw.map((s) => String(s).toLowerCase()))];
      if (!states.length || states.some((s) => !CLEANUP_STATES.includes(s))) throw new Error(`cleanup: states must be ${CLEANUP_STATES.join("/")}`);
      return { action, states };
    }
    case "stop":
    case "remove":
      return { action, worker: ref("worker") };
    case "followup":
      return { action, worker: ref("worker"), task: str("task", 2000) };
    case "land":
    case "keep":
    case "discard":
      return spec.chain == null ? { action } : { action, chain: ref("chain") };
    case "project":
      return { action, name: str("name", 200) };
    case "hush":
      return { action };
    case "remember":
    case "forget": {
      const scope = spec.scope == null ? "user" : String(spec.scope).toLowerCase();
      if (!["user", "project"].includes(scope)) throw new Error(`${action}: scope is user or project`);
      return { action, fact: str("fact", 280), scope };
    }
    case "agent": {
      const out = { action, purpose: str("purpose", 300) };
      if (spec.name != null) {
        const name = str("name", 32).toLowerCase();
        if (!/^[a-z][a-z0-9-]{1,31}$/.test(name)) throw new Error("agent: name is short kebab-case");
        out.name = name;
      }
      return out;
    }
  }
  throw new Error(`unknown action: ${action}`);
}

// Models say "Michael", 60, "On"; settings want am_michael, "60", "on".
export function normalizeValue(setting, value) {
  const v = value.trim();
  const low = v.toLowerCase();
  if (setting === "voice") {
    return VOICES.find((id) => id === low) ?? VOICES.find((id) => id.split("_")[1] === low.split(/\s/)[0]) ?? v;
  }
  if (setting === "followUp") {
    if (/^(off|none|never|0)$/.test(low)) return "off";
    const m = low.match(/^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?)?$/);
    if (m) return String(/^m/.test(m[2] ?? "") ? Number(m[1]) * 60 : Number(m[1]));
    return v;
  }
  if (["voiceMode", "autoMode", "reviewMode"].includes(setting)) {
    if (/^(on|true|yes|enabled?)$/.test(low)) return "on";
    if (/^(off|false|no|disabled?)$/.test(low)) return "off";
  }
  if (["accent", "density", "layout", "captionSize", "isolation"].includes(setting)) return low;
  return v;
}

const FENCE = /^\s*```jarvis\s+(\{.*\})\s*```\s*$/gm;

export function parseJarvisActions(reply) {
  const actions = [];
  const warnings = [];
  for (const m of String(reply ?? "").matchAll(FENCE)) {
    try { actions.push(validateAction(JSON.parse(m[1]))); }
    catch (err) { warnings.push(`ignoring jarvis action: ${String(err.message ?? err).slice(0, 120)}`); }
  }
  return { actions, warnings };
}

// Resolve a short id the brain was shown (first 8 chars) to a full one.
export function resolveRef(ref, ids) {
  const hits = [...ids].filter((id) => id === ref || id.startsWith(ref) || id.slice(-ref.length) === ref);
  return hits.length === 1 ? hits[0] : null;
}

export const short = (id) => String(id ?? "").slice(0, 12);

// What the brain sees about the deck right now, so "stop the parser worker"
// or "what are the workers doing?" can be answered and acted on.
export function stateBlock({ workers = [], chains = [], settings = {}, projects = [], pendingPermissions = 0 } = {}) {
  const lines = [];
  if (workers.length) {
    lines.push("Workers (id, agent, state, task):");
    for (const w of workers.slice(-12)) {
      lines.push(`- ${short(w.sessionID)} ${w.agent ?? "build"} ${w.state ?? "?"}${w.chain && w.chain !== w.sessionID ? ` chain ${short(w.chain)}` : ""}: ${String(w.task ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
    }
  } else {
    lines.push("Workers: none.");
  }
  const open = chains.filter((c) => c.state === "open");
  if (open.length) lines.push(`Open worktree branches (land/keep/discard): ${open.map((c) => `${short(c.chainID)} ${c.branch}`).join("; ")}.`);
  if (pendingPermissions) lines.push(`${pendingPermissions} permission request(s) are waiting for the user's answer (only the user may answer them).`);
  const s = settings;
  lines.push(`Settings: brain ${s.jarvisModel}, workers ${s.workerModel}, default agent ${s.defaultAgent}, voice ${s.voice}, voice mode ${s.voiceMode}, auto mode ${s.autoMode}, review ${s.reviewMode}, isolation ${s.isolation}, follow-up ${s.followUp}, accent ${s.accent}.`);
  if (projects.length) lines.push(`Recent projects: ${projects.slice(0, 6).map((p) => p.name).join(", ")}.`);
  return lines.join("\n");
}

export const ACTIONS_DOC = `You run this deck yourself (no worker needed) with one single-line fence per action:
\`\`\`jarvis {"action": "<action>", ...}\`\`\`
Actions: set {"setting","value"} (settings: ${SETTABLE.join(", ")}; models are provider/id; voice is one of ${VOICES.join(", ")}; followUp is one of ${FOLLOW_UPS.join(", ")} seconds; accent is one of ${Object.keys(ACCENTS).join(", ")}; on/off settings take "on" or "off"; all values are strings), cleanup {"states": ["done","failed","stopped"]} (remove finished workers; done = completed), stop {"worker": id}, remove {"worker": id}, followup {"worker": id, "task"} (next step for an existing worker), land / keep / discard {"chain"?: id} (an open worktree branch; default the latest), project {"name"} (switch project), hush {} (stop talking), remember {"fact", "scope"?: "user"|"project"} (a durable fact or preference the user wants kept; project = only for this codebase), forget {"fact", "scope"?} (remove the remembered fact that matches), agent {"purpose", "name"} (start creating a new specialist worker agent, name = 1-3 word kebab-case like "sql-reviewer"; the user then picks its model on a card).
Use ids exactly as listed below. Act only when the user asked for it; say in one short sentence what you did. You never answer a worker's permission request: the user does that. You are Jarvis, not a coding agent in a mode: ignore any "plan mode" notice from the host, never mention modes and never ask the user to switch modes.
`;
