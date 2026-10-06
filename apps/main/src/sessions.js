import { ensureClient } from "./service.js";
import { runTurn, isQuotaError, READONLY_PERMISSIONS, BRAIN_AGENT } from "./turn.js";

export const JARVIS_MODEL = { providerID: "opencode-go", id: "gpt-6-luna" };
export const JARVIS_FALLBACK_MODEL = { providerID: "opencode", id: "fledge-alpha-free" };
let jarvisSessionID = null;
let jarvisModelUsed = null;

export function parseModelRef(ref) {
  if (!ref) return null;
  const slash = ref.indexOf("/");
  if (slash < 0) return null;
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export async function ensureJarvisSession(directory, model) {
  const { client } = await ensureClient();
  if (jarvisSessionID) return jarvisSessionID;
  const m = model ?? parseModelRef(process.env.JARVIS_MODEL) ?? JARVIS_MODEL;
  const session = await client.session.create({
    agent: "build",
    model: m,
    location: { directory },
  });
  jarvisSessionID = session.id;
  jarvisModelUsed = m;
  return jarvisSessionID;
}

// Direct fallback when the brain graph fails: one read-only turn on its own
// session. Never on the worker parent session, which runs the build agent.
let directSessionID = null;
let directModelUsed = null;

async function createDirectSession(model) {
  const { client } = await ensureClient();
  const session = await client.session.create({
    agent: BRAIN_AGENT,
    model,
    location: { directory: process.cwd() },
    title: "jarvis direct",
    permissions: READONLY_PERMISSIONS,
  });
  directSessionID = session.id;
  directModelUsed = model;
  return directSessionID;
}

export async function promptJarvis(text, onDelta, opts = {}) {
  const wanted = opts.model ?? parseModelRef(process.env.JARVIS_MODEL) ?? JARVIS_MODEL;
  let sessionID = directSessionID ?? (await createDirectSession(wanted));
  const turn = (sid) => runTurn(sid, text, { onDelta, timeoutMs: opts.timeoutMs, files: opts.files });
  let r = await turn(sessionID);
  const isFallback = wanted.providerID === JARVIS_FALLBACK_MODEL.providerID && wanted.id === JARVIS_FALLBACK_MODEL.id;
  if (r.status === "failed" && isQuotaError(r.error) && !isFallback) {
    sessionID = await createDirectSession(JARVIS_FALLBACK_MODEL);
    r = await turn(sessionID);
  }
  return { sessionID, modelUsed: directModelUsed, ...r };
}
