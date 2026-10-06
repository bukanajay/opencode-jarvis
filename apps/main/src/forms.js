// Forms: blocking cards, not toasts. The server emits no creation event,
// so the gate detects via the question-tool call and re-lists.
import { ensureClient } from "./service.js";

export const pendingForms = new Map(); // formID -> { formID, sessionID, form }

export async function listForms(sessionID) {
  const { client } = await ensureClient();
  const r = await client.session.form.list({ sessionID });
  const arr = r?.forms ?? r?.data ?? (Array.isArray(r) ? r : []);
  return Array.isArray(arr) ? arr : [];
}

export async function refreshForms(sessionID) {
  const forms = await listForms(sessionID).catch(() => []);
  for (const [id, p] of pendingForms) {
    if (p.sessionID === sessionID && !forms.some((f) => (f.id ?? f.formID) === id)) {
      pendingForms.delete(id);
    }
  }
  for (const f of forms) {
    const id = f.id ?? f.formID;
    if (id && !pendingForms.has(id)) pendingForms.set(id, { formID: id, sessionID, form: f });
  }
  return forms;
}

export function formsFor(sessionID) {
  return [...pendingForms.values()].filter((p) => p.sessionID === sessionID);
}

export async function replyForm(sessionID, formID, answer) {
  const { client } = await ensureClient();
  if (!pendingForms.has(formID)) {
    const forms = await refreshForms(sessionID);
    if (!forms.some((f) => (f.id ?? f.formID) === formID)) throw new Error(`no pending form: ${formID}`);
  }
  const out = await client.session.form.reply({ sessionID, formID, answer });
  pendingForms.delete(formID);
  return out;
}

// Voice: spoken option value/label answers single-field option forms. Nothing else.
export function matchFormAnswer(form, text) {
  const fields = form?.fields ?? [];
  if (fields.length !== 1) return null;
  const field = fields[0];
  const options = field.options ?? [];
  if (options.length === 0) return null;
  const t = String(text ?? "").trim().toLowerCase();
  const hit = options.find((o) => String(o.value ?? o.label ?? "").toLowerCase() === t)
    ?? options.find((o) => t.includes(String(o.value ?? o.label ?? "").toLowerCase()));
  if (!hit) return null;
  return { [field.key]: hit.value ?? hit.label };
}
