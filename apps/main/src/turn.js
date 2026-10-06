// One prompt turn on one session: stream text deltas, settle on
// succeeded/failed/interrupted or timeout. Shared by the brain and the direct
// Jarvis fallback so both handle permissions the same way.
import { ensureClient } from "./service.js";

// Jarvis thinks, workers act. Sessions created with these rules can read the
// project (read/grep/glob/list) but cannot change it or spawn their own
// subagents; delegation goes through dispatch fences only.
export const READONLY_PERMISSIONS = ["edit", "write", "patch", "bash", "shell", "task"].map((action) => ({
  action,
  resource: "*",
  effect: "deny",
}));

export const BRAIN_AGENT = process.env.JARVIS_BRAIN_AGENT || "plan";

export function isQuotaError(error) {
  return /quota|rate-limit|429/i.test(JSON.stringify(error ?? ""));
}

export function deltaText(delta) {
  return typeof delta === "string" ? delta : delta?.text ?? "";
}

// opts: onDelta(chunk), timeoutMs, files, rejectPermissions (default true),
// client (tests inject a fake; defaults to the shared client).
// A read-only session should never ask; if it does anyway (agent without the
// deny rules, server default "ask"), reject at once instead of hanging the
// turn until timeout, because nothing on the deck answers the brain's asks.
export async function runTurn(sessionID, text, opts = {}) {
  const client = opts.client ?? (await ensureClient()).client;
  const { onDelta, timeoutMs = 180000, files, rejectPermissions = true } = opts;
  const controller = new AbortController();
  const sub = client.event.subscribe({ signal: controller.signal });
  let full = "";
  let rejected = 0;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const timer = setTimeout(() => settle({ status: "timeout", text: full }), timeoutMs);
  (async () => {
    for await (const ev of sub) {
      const d = ev.data ?? {};
      if (d.sessionID !== sessionID) continue;
      if (ev.type === "session.text.delta" && d.delta) {
        const chunk = deltaText(d.delta);
        full += chunk;
        onDelta?.(chunk);
      } else if (ev.type === "permission.asked" && rejectPermissions) {
        rejected++;
        client.permission.reply({ sessionID, requestID: d.id, decision: "reject" }).catch(() => {});
      } else if (ev.type === "session.execution.succeeded") {
        settle({ status: "ok", text: full });
        return;
      } else if (ev.type === "session.execution.failed") {
        settle({ status: "failed", text: full, error: d.error });
        return;
      } else if (ev.type === "session.execution.interrupted") {
        settle({ status: "interrupted", text: full });
        return;
      }
    }
    settle({ status: "failed", text: full, error: "event stream closed" });
  })().catch((err) => settle({ status: "failed", text: full, error: String(err?.message ?? err) }));
  try {
    await client.session.prompt(files?.length ? { sessionID, text, files } : { sessionID, text });
  } catch (err) {
    settle({ status: "failed", text: full, error: String(err?.message ?? err), thrown: err });
  }
  const r = await done;
  clearTimeout(timer);
  controller.abort();
  if (r.thrown) throw r.thrown;
  return rejected ? { ...r, permissionsRejected: rejected } : r;
}
