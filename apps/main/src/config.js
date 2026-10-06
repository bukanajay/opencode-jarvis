// Server-config bucket: Main writes, OpenCode reloads, Jarvis reads back and confirms.
// Non-widening (agent file) applies immediately. Widening (allow rules,
// session deletes) stages a pending change and needs a second spoken confirm.
import fs from "node:fs";
import path from "node:path";
import { ensureClient } from "./service.js";

export const pendingConfigs = new Map(); // pendingID -> staged change
let seq = 0;

export function agentsDir(directory) {
  return path.join(directory, ".opencode", "agents");
}

function slug(name) {
  const s = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s || s.length > 48) throw new Error(`bad agent name: ${JSON.stringify(name)}`);
  return s;
}

function frontmatter({ description, mode, permission }) {
  const lines = ["---", `description: ${description}`, `mode: ${mode}`];
  if (permission && Object.keys(permission).length > 0) {
    lines.push("permission:");
    for (const [k, v] of Object.entries(permission)) lines.push(`  ${k}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

// "add a read-only reviewer" and its narrow variants. Exact, enumerable.
export function matchConfigCommand(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (/^add a (read-only |readonly )?reviewer$/.test(t) || t === "add a code reviewer") {
    return {
      kind: "agent-file",
      widening: false,
      name: "reviewer",
      description: "Read-only code reviewer. Reports findings, changes nothing.",
      mode: "subagent",
      permission: { edit: "deny", bash: "deny" },
      prompt: "You are a read-only reviewer. Focus on correctness, security, and missing tests. Report findings as text. Never create, edit, or delete files, and never run shell commands.",
      summary: "Add read-only reviewer agent (edit deny, bash deny)",
    };
  }
  if (t === "let every agent run any shell command") {
    return {
      kind: "permission-allow-rule",
      widening: true,
      action: "shell",
      resources: ["*"],
      effect: "allow",
      summary: "Allow every agent to run any shell command",
    };
  }
  if (/^delete the worker$/.test(t)) {
    return { kind: "session-delete", widening: true, summary: "Delete the latest worker session" };
  }
  return null;
}

export function isWidening(match) {
  return match?.widening === true;
}

async function waitForAgent(client, directory, name, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const agents = await client.agent.list({ location: { directory } });
    const found = (agents.data ?? []).find((a) => a.id === name);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`agent ${name} did not appear after write (reload missed?)`);
}

// Direct apply: agent file only. Verifies via agent list + get before reporting.
export async function applyAgentFile(client, directory, spec) {
  const name = slug(spec.name);
  const dir = agentsDir(directory);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, frontmatter(spec) + "\n" + (spec.prompt ?? "") + "\n");
  const listed = await waitForAgent(client, directory, name);
  const got = await client.agent.get({ agentID: name, location: { directory } });
  const info = got.data ?? {};
  const perms = info.permissions ?? listed.permissions ?? [];
  const editRule = perms.find((p) => p.action === "edit");
  return {
    ok: true,
    name,
    file,
    live: true,
    needsRestart: false,
    mode: info.mode ?? listed.mode,
    editEffect: editRule?.effect,
    note: `server reloaded, ${name} exists (mode ${info.mode ?? listed.mode}, edit ${editRule?.effect})`,
  };
}

export async function removeAgentFile(client, directory, name) {
  const file = path.join(agentsDir(directory), `${slug(name)}.md`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const agents = await client.agent.list({ location: { directory } });
    if (!(agents.data ?? []).some((a) => a.id === slug(name))) return { ok: true, removed: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: true, removed: false, note: "file removed, list still shows it (reload lag)" };
}

// Widening: stage first, apply only on second confirm. Shows the exact rule.
export function stageWidening(spec) {
  const pendingID = `cfg_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const staged = { pendingID, at: Date.now(), ...spec };
  pendingConfigs.set(pendingID, staged);
  return staged;
}

export async function confirmWidening(client, directory, pendingID, confirmed, hooks = {}) {
  const staged = pendingConfigs.get(pendingID);
  if (!staged) throw new Error(`no pending config: ${pendingID}`);
  pendingConfigs.delete(pendingID);
  if (!confirmed) return { ok: true, applied: false, summary: staged.summary };
  if (staged.kind === "permission-allow-rule") {
    // Saved via API; audit records the exact rule. Project-wide file rules
    // use the same stage->confirm gate with a watched opencode.jsonc write.
    const sessionID = await hooks.jarvisSessionID?.();
    const saved = await client.permission.create({
      sessionID,
      action: staged.action,
      resources: staged.resources,
    });
    return { ok: true, applied: true, summary: staged.summary, rule: staged, saved };
  }
  if (staged.kind === "session-delete") {
    const target = await hooks.resolveTarget?.(staged);
    if (!target) throw new Error("nothing to delete");
    await hooks.deleteTarget?.(target);
    return { ok: true, applied: true, summary: staged.summary, target };
  }
  throw new Error(`unknown widening kind: ${staged.kind}`);
}
