// Parity 2 — Permissions and forms: question tool blocks, hand or voice answers.
import process from "node:process";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
const { spawnWorker, deleteWorker, ensureFleetPump, routeUtterance } = await import("../apps/main/src/fleet.js");
const { pendingForms, refreshForms, replyForm, matchFormAnswer } = await import("../apps/main/src/forms.js");

// Voice matcher is pure: option text answers, anything else stays model-side.
const sample = { fields: [{ key: "q0", title: "Ship", options: [{ value: "yes", label: "yes" }, { value: "no", label: "no" }] }] };
if (JSON.stringify(matchFormAnswer(sample, "yes")) !== JSON.stringify({ q0: "yes" })) throw new Error("voice yes mismatch");
if (JSON.stringify(matchFormAnswer(sample, "No")) !== JSON.stringify({ q0: "no" })) throw new Error("voice no mismatch");
if (matchFormAnswer(sample, "maybe") !== null) throw new Error("voice leak");
if (matchFormAnswer({ fields: [] }, "yes") !== null) throw new Error("empty leak");
const rVoice = routeUtterance("yes", false, false, { q0: "yes" });
if (rVoice.route !== "form.answer") throw new Error("form.answer misroute");
console.log("route-ok: option text answers single-field forms, nothing else");

let waiting = null;
const toolsSeen = [];
await ensureFleetPump((ev) => {
  if (ev.kind === "form.waiting") waiting = ev;
  if (ev.kind === "worker.tool") toolsSeen.push(ev.tool);
});
const TASK = "Call the question tool with header \"Ship\", question \"Proceed?\", options yes and no. Wait for my answer.";
let w = await spawnWorker(TASK);
console.log(`worker=${w.sessionID}`);
let t0 = Date.now();
while (!waiting && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 1000));
if (!waiting) {
  console.log(`retry: tools seen=${toolsSeen.join(",") || "none"} — respawning`);
  await deleteWorker(w.sessionID).catch(() => {});
  toolsSeen.length = 0;
  w = await spawnWorker(TASK);
  console.log(`worker=${w.sessionID} (retry)`);
  t0 = Date.now();
  while (!waiting && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 1000));
}
if (!waiting) {
  // Fallback: the server emits no creation event; re-list directly.
  const { ensureClient } = await import("../apps/main/src/service.js");
  const { client } = await ensureClient();
  const sub = client.event.subscribe();
  const probe = (async () => {
    for await (const ev of sub) {
      if (ev.type === "session.tool.called" && (ev.data?.name === "question")) break;
    }
  })();
  await Promise.race([probe, new Promise((r) => setTimeout(r, 60000))]);
  if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
  const forms = await refreshForms(w.sessionID);
  if (forms.length > 0) waiting = { forms };
}
if (!waiting) throw new Error("no form appeared");
const form = waiting.forms[0];
console.log(`form-ok: ${form.title} options=${(form.fields?.[0]?.options ?? []).map((o) => o.value).join(",")}`);

const answer = matchFormAnswer(form, "yes");
if (!answer) throw new Error("live form not voice-answerable");
await replyForm(w.sessionID, form.formID ?? form.id, answer);
console.log("reply-ok: voice answer sent");

const { ensureClient } = await import("../apps/main/src/service.js");
const { client } = await ensureClient();
const end = await new Promise((resolve) => {
  const to = setTimeout(() => resolve("timeout"), 90000);
  (async () => {
    const sub = client.event.subscribe();
    for await (const ev of sub) {
      const d = ev.data ?? {};
      if (d.sessionID !== w.sessionID) continue;
      if (ev.type === "session.execution.succeeded") { clearTimeout(to); resolve("ok"); break; }
      if (ev.type === "session.execution.failed") { clearTimeout(to); resolve("failed"); break; }
    }
  })();
});
if (end !== "ok") throw new Error(`worker did not finish after answer (${end})`);
const rest = await refreshForms(w.sessionID);
if (rest.length !== 0) throw new Error("form still pending after reply");
console.log("done-ok: worker finished, no forms pending");
await deleteWorker(w.sessionID).catch(() => {});
console.log("forms-ok");
process.exit(0);
