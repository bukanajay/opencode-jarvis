// Bootstrap: first-run fleet creation. Empty fleet -> ask -> staged Q&A -> agent file.
// Pure stage machine (purpose -> provider -> model -> effort -> confirm -> create);
// only the final create step touches disk + server (writes .opencode/agents/<slug>.md,
// verifies via agent.list + agent.get, mirroring config.js applyAgentFile).
import fs from "node:fs";
import path from "node:path";

export const BUILTINS = ["build", "plan", "general", "explore", "scout", "compaction", "title", "summary"];

export const EFFORTS = { low: { steps: 5 }, medium: { steps: 15 }, high: { steps: 30 } };

export const DEFAULT_PERMISSIONS = { edit: "allow", bash: "allow" };

export const pendingBootstraps = new Map(); // bootID -> conversation
let bootSeq = 0;

export function bootstrapAgentsDir(directory) {
  return path.join(directory, ".opencode", "agents");
}

function slugify(text) {
  const s = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s;
}

function oneLine(text, max = 120) {
  return String(text ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function modelsFor(ctx, provider) {
  return ctx?.modelsByProvider?.[provider] ?? ctx?.models ?? [];
}

// Custom fleet: everything the server lists minus built-ins.
export async function getFleetAgents(client, directory) {
  const res = await client.agent.list({ location: { directory } });
  const all = res.data ?? res.agents ?? (Array.isArray(res) ? res : []);
  return all
    .filter((a) => !BUILTINS.includes(a.id ?? a.name))
    .map((a) => ({ id: a.id ?? a.name, description: a.description ?? "", mode: a.mode ?? "" }));
}

// Gate main.js calls before dispatching a worker when no explicit agent was given.
export async function ensureFleetOrAsk(client, directory) {
  const agents = await getFleetAgents(client, directory);
  if (agents.length > 0) return { state: "ready", agents };
  return {
    state: "empty",
    prompt: "There is no agent for this task yet. Create one now? (yes/no)",
  };
}

function modelRows(res) {
  return res?.data ?? res?.models ?? (Array.isArray(res) ? res : []);
}

export async function listProviders(client) {
  const rows = modelRows(await client.model.list());
  return [...new Set(rows.map((m) => m.providerID ?? m.provider).filter(Boolean))];
}

export async function listModelsFor(client, providerID) {
  const rows = modelRows(await client.model.list());
  return rows
    .filter((m) => (m.providerID ?? m.provider) === providerID)
    .map((m) => m.id ?? m.name)
    .filter(Boolean);
}

// Exact spec shown at confirm and written on create.
export function confirmSpec(conv) {
  return {
    name: conv.name,
    provider: conv.provider,
    model: conv.model,
    effort: conv.effort,
    permissions: { ...DEFAULT_PERMISSIONS },
  };
}

// `model:` is a standard opencode agent frontmatter key; `steps` is not, so the
// step budget rides in the prompt footer instead of frontmatter.
export function agentFileBody(conv) {
  const steps = EFFORTS[conv.effort]?.steps ?? EFFORTS.medium.steps;
  const head = ["---", `description: ${oneLine(conv.purpose)}`, "mode: subagent", `model: ${conv.provider}/${conv.model}`, "---"].join("\n") + "\n";
  const body = `\n${oneLine(conv.purpose, 500)}\n\nBudget: work in at most ${steps} steps (effort ${conv.effort}). If the task needs more, stop and report back instead of continuing.\n`;
  return head + body;
}

export function startCreate(fleetSnapshot) {
  const id = `boot_${Date.now().toString(36)}_${(bootSeq++).toString(36)}`;
  const conv = {
    id,
    stage: "purpose",
    purpose: null,
    provider: null,
    model: null,
    effort: null,
    name: null,
    fleet: fleetSnapshot ?? [],
    at: Date.now(),
    prompt: "What is the agent for? Describe its job in one line (e.g. 'api tester').",
  };
  pendingBootstraps.set(id, conv);
  return conv;
}

function cancelled(conv) {
  pendingBootstraps.delete(conv.id);
  conv.stage = "cancelled";
  return { stage: "cancelled", prompt: "Cancelled — no agent created." };
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

// Advance one stage. Pure except confirm+"yes", which writes + verifies.
// ctx: { providers?, models?, modelsByProvider?, client?, directory? }.
export async function answerCreate(conv, text, ctx = {}) {
  const t = String(text ?? "").trim();
  const low = t.toLowerCase();
  if (low === "cancel" || low === "no") return cancelled(conv);
  switch (conv.stage) {
    case "purpose": {
      const name = slugify(t);
      if (!name) return { stage: "purpose", prompt: "That didn't give me a usable name — what is the agent for? (one line, e.g. 'api tester')" };
      conv.purpose = oneLine(t, 500);
      conv.name = name;
      conv.stage = "provider";
      const providers = ctx.providers ?? [];
      return {
        stage: "provider",
        prompt: `What provider should ${name} use?${providers.length ? ` (${providers.join(", ")})` : ""}`,
        ...(providers.length ? { options: providers } : {}),
      };
    }
    case "provider": {
      const providers = ctx.providers ?? [];
      const hit = providers.find((p) => String(p).toLowerCase() === low);
      if (!hit) {
        return {
          stage: "provider",
          prompt: `"${t}" isn't a known provider. Pick one: ${providers.join(", ") || "none available"}`,
          ...(providers.length ? { options: providers } : {}),
        };
      }
      conv.provider = hit;
      conv.stage = "model";
      const models = modelsFor(ctx, hit);
      return {
        stage: "model",
        prompt: `Which ${hit} model should ${conv.name} use?`,
        ...(models.length ? { options: models } : {}),
      };
    }
    case "model": {
      const models = modelsFor(ctx, conv.provider);
      const hit = models.find((m) => String(m).toLowerCase() === low);
      if (!hit) {
        return {
          stage: "model",
          prompt: `"${t}" isn't a ${conv.provider} model I know. Pick one.`,
          ...(models.length ? { options: models } : {}),
        };
      }
      conv.model = hit;
      conv.stage = "effort";
      return {
        stage: "effort",
        prompt: `How much effort should ${conv.name} spend per task? (low ≤5 steps, medium ≤15, high ≤30)`,
        options: ["low", "medium", "high"],
      };
    }
    case "effort": {
      if (!EFFORTS[low]) {
        return { stage: "effort", prompt: `"${t}" isn't valid — pick low, medium, or high.`, options: ["low", "medium", "high"] };
      }
      conv.effort = low;
      conv.stage = "confirm";
      const spec = confirmSpec(conv);
      return { stage: "confirm", prompt: `Create this agent? ${JSON.stringify(spec)} Say "yes" to create or "no" to cancel.`, spec };
    }
    case "confirm": {
      if (low === "yes" || low.startsWith("yes,") || ["y", "confirm", "create", "do it", "apply it"].includes(low)) {
        const { client, directory } = ctx;
        if (!client || !directory) throw new Error("bootstrap create needs ctx.client + ctx.directory");
        const dir = bootstrapAgentsDir(directory);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${conv.name}.md`), agentFileBody(conv));
        const listed = await waitForAgent(client, directory, conv.name);
        const got = await client.agent.get({ agentID: conv.name, location: { directory } }).catch(() => null);
        const info = got?.data ?? {};
        conv.stage = "done";
        pendingBootstraps.delete(conv.id);
        return {
          stage: "done",
          name: conv.name,
          note: `created ${conv.name} (${conv.provider}/${conv.model}, effort ${conv.effort}, ≤${EFFORTS[conv.effort].steps} steps), server reloaded (mode ${info.mode ?? listed.mode ?? "subagent"})`,
        };
      }
      const spec = confirmSpec(conv);
      return { stage: "confirm", prompt: `Say "yes" to create ${JSON.stringify(spec)} or "no" to cancel.`, spec };
    }
    default:
      throw new Error(`bootstrap: unknown stage ${JSON.stringify(conv.stage)}`);
  }
}
