import { ensureClient } from "./service.js";

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

function sessionOf(ev, sessionID) {
  const d = ev.data ?? {};
  return d.sessionID === sessionID ? d : null;
}

export async function promptJarvis(text, onDelta, opts = {}) {
  const { client } = await ensureClient();
  const wanted = opts.model ?? parseModelRef(process.env.JARVIS_MODEL) ?? JARVIS_MODEL;
  let sessionID = await ensureJarvisSession(process.cwd(), wanted);
  const runOnce = (sid) =>
    new Promise(async (resolve, reject) => {
      const sub = client.event.subscribe();
      let full = "";
      const timer = setTimeout(() => resolve({ status: "timeout", text: full }), opts.timeoutMs ?? 60000);
      (async () => {
        for await (const ev of sub) {
          const d = sessionOf(ev, sid);
          if (!d) continue;
          if (ev.type === "session.text.delta" && d.delta) {
            const chunk = typeof d.delta === "string" ? d.delta : d.delta.text ?? "";
            full += chunk;
            if (onDelta) onDelta(chunk);
          }
          if (ev.type === "session.execution.succeeded") {
            clearTimeout(timer);
            if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
            resolve({ status: "ok", text: full });
            break;
          }
          if (ev.type === "session.execution.failed") {
            clearTimeout(timer);
            if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
            resolve({ status: "failed", text: full, error: d.error });
            break;
          }
        }
      })().catch(reject);
      try {
        await client.session.prompt({ sessionID: sid, text });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });

  let r = await runOnce(sessionID);
  let modelUsed = jarvisModelUsed;
  const quota = r.status === "failed" && JSON.stringify(r.error ?? "").match(/quota|rate-limit|429/i);
  if (quota && (wanted.providerID !== JARVIS_FALLBACK_MODEL.providerID || wanted.id !== JARVIS_FALLBACK_MODEL.id)) {
    const { client: c2 } = await ensureClient();
    const s2 = await c2.session.create({
      agent: "build",
      model: JARVIS_FALLBACK_MODEL,
      location: { directory: process.cwd() },
    });
    jarvisSessionID = s2.id;
    jarvisModelUsed = JARVIS_FALLBACK_MODEL;
    sessionID = s2.id;
    modelUsed = JARVIS_FALLBACK_MODEL;
    r = await runOnce(sessionID);
  }
  return { sessionID, modelUsed, ...r };
}
