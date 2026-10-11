// Decision inbox: everything that is waiting on the user, in one queue.
// Built fresh from the live pending maps (permissions, config widenings,
// agent creation, worker forms, finished worktree branches), so it can never
// drift from what Main actually holds. Pure; Main executes the answers.

const short = (id) => String(id ?? "").slice(0, 8);
const clip = (s, n = 140) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Most urgent first: a blocked worker beats a branch that can wait.
const RANK = { permission: 0, config: 1, form: 2, agent: 3, branch: 4, rule: 5 };

export function buildInbox({ permissions = [], configs = [], bootstraps = [], forms = [], chains = [], workers = new Map(), suggestions = [] } = {}) {
  const items = [];
  for (const s of suggestions) {
    items.push({
      id: `rule:${s.signature}`,
      kind: "rule",
      title: `Always allow ${s.label}?`,
      detail: `You approved it ${s.count} times. Workers would no longer ask for it.`,
      ref: s.signature,
      at: s.at ?? 0,
      actions: ["always", "dismiss"],
    });
  }
  for (const p of permissions) {
    const w = workers.get(p.sessionID);
    items.push({
      id: `perm:${p.requestID}`,
      kind: "permission",
      title: `${w?.agent ?? "Worker"} wants ${p.action ?? "permission"}`,
      detail: clip((p.resources ?? []).join(" ") || w?.task),
      ref: p.requestID,
      sessionID: p.sessionID,
      at: p.at ?? 0,
      actions: ["allow", "deny"],
    });
  }
  for (const c of configs) {
    items.push({
      id: `cfg:${c.pendingID}`,
      kind: "config",
      title: "Config change needs your OK",
      detail: clip(c.summary),
      ref: c.pendingID,
      at: c.at ?? 0,
      actions: ["confirm", "cancel"],
    });
  }
  for (const f of forms) {
    const w = workers.get(f.sessionID);
    items.push({
      id: `form:${f.formID}`,
      kind: "form",
      title: `${w?.agent ?? "Worker"} is asking a question`,
      detail: clip(f.form?.title ?? w?.task),
      ref: f.formID,
      sessionID: f.sessionID,
      at: f.at ?? 0,
      actions: ["open"],
    });
  }
  for (const b of bootstraps) {
    items.push({
      id: `agent:${b.id}`,
      kind: "agent",
      title: b.name ? `New agent ${b.name}` : "New agent",
      detail: clip(b.prompt ?? "answer on the card"),
      ref: b.id,
      at: b.at ?? 0,
      actions: ["open", "cancel"],
    });
  }
  for (const c of chains) {
    if (c.state !== "open" || c.busy) continue;
    items.push({
      id: `branch:${c.chainID}`,
      kind: "branch",
      title: `Branch ${c.branch} is ready`,
      detail: clip(c.task ?? `worktree from ${short(c.chainID)}`),
      ref: c.chainID,
      at: c.at ?? 0,
      actions: ["land", "keep", "discard"],
    });
  }
  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.at - b.at);
}

// Stable fingerprint so Main only broadcasts / notifies on real changes.
export function inboxKey(items) {
  return items.map((i) => i.id).join("|");
}

// Ids present now that were not there before: what to notify about.
export function newItems(prev, next) {
  const seen = new Set(prev.map((i) => i.id));
  return next.filter((i) => !seen.has(i.id));
}

// One line for the brain's state block and the brief.
export function inboxSummary(items) {
  if (!items.length) return "Decision inbox: empty.";
  return `Decision inbox (${items.length}, only the user decides): ${items.slice(0, 6).map((i) => `${i.title}${i.detail ? ` (${clip(i.detail, 60)})` : ""}`).join("; ")}.`;
}

export const ACTIONS_BY_KIND = Object.freeze({
  permission: ["allow", "deny"],
  config: ["confirm", "cancel"],
  form: ["open"],
  agent: ["open", "cancel"],
  branch: ["land", "keep", "discard"],
  rule: ["always", "dismiss"],
});
