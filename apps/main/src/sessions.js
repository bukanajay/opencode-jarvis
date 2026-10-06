import { ensureClient } from "./service.js";
import { runTurn, isQuotaError, READONLY_PERMISSIONS, BRAIN_AGENT } from "./turn.js";
import { projectDir, readProjectState, writeProjectState } from "./project.js";

export const JARVIS_MODEL = { providerID: "opencode-go", id: "gpt-6-luna" };
export const JARVIS_FALLBACK_MODEL = { providerID: "opencode", id: "fledge-alpha-free" };

export function parseModelRef(ref) {
  if (!ref) return null;
  const slash = ref.indexOf("/");
  if (slash < 0) return null;
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

// Worker parent ("jarvis") session, one per project. Its id is persisted in
// the project's state so workers spawned before a restart are still found
// (and rehydrated) as its children.
const parentSessions = new Map(); // directory -> sessionID

export async function ensureJarvisSession(directory = projectDir(), model) {
  if (parentSessions.has(directory)) return parentSessions.get(directory);
  const { client } = await ensureClient();
  const saved = readProjectState(directory).parentSessionID;
  if (saved) {
    const info = await client.session.get({ sessionID: saved }).catch(() => null);
    if (info?.id === saved && !info.time?.archived) {
      parentSessions.set(directory, saved);
      return saved;
    }
  }
  const m = model ?? parseModelRef(process.env.JARVIS_MODEL) ?? JARVIS_MODEL;
  const session = await client.session.create({
    agent: "build",
    model: m,
    location: { directory },
    title: "jarvis",
  });
  parentSessions.set(directory, session.id);
  writeProjectState({ parentSessionID: session.id }, directory);
  return session.id;
}

// Direct fallback when the brain graph fails: one read-only turn on its own
// session. Never on the worker parent session, which runs the build agent.
const directSessions = new Map(); // directory -> { id, model }

async function createDirectSession(directory, model) {
  const { client } = await ensureClient();
  const session = await client.session.create({
    agent: BRAIN_AGENT,
    model,
    location: { directory },
    title: "jarvis direct",
    permissions: READONLY_PERMISSIONS,
  });
  directSessions.set(directory, { id: session.id, model });
  return session.id;
}

export async function promptJarvis(text, onDelta, opts = {}) {
  const directory = opts.directory ?? projectDir();
  const wanted = opts.model ?? parseModelRef(process.env.JARVIS_MODEL) ?? JARVIS_MODEL;
  let sessionID = directSessions.get(directory)?.id ?? (await createDirectSession(directory, wanted));
  const turn = (sid) => runTurn(sid, text, { onDelta, timeoutMs: opts.timeoutMs, files: opts.files });
  let r = await turn(sessionID);
  const isFallback = wanted.providerID === JARVIS_FALLBACK_MODEL.providerID && wanted.id === JARVIS_FALLBACK_MODEL.id;
  if (r.status === "failed" && isQuotaError(r.error) && !isFallback) {
    sessionID = await createDirectSession(directory, JARVIS_FALLBACK_MODEL);
    r = await turn(sessionID);
  }
  return { sessionID, modelUsed: directSessions.get(directory)?.model ?? wanted, ...r };
}
