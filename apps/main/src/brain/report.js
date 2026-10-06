// Worker reports: what a finished worker said and changed, condensed for the
// brain's review turn. Pure shaping lives here; collectWorkerReport is the
// only function that talks to the server.

export const MAX_ROUNDS = Number(process.env.JARVIS_MAX_ROUNDS ?? 3);
const FINAL_TEXT_LIMIT = 4000;
const MAX_FILES = 40;
const PATCH_BUDGET = 6000;

// Last assistant turn's text (all text parts of the trailing assistant run,
// so a reply split across tool steps is kept whole). Reasoning and tool parts
// are dropped.
export function finalAssistantText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    const kind = m?.type ?? m?.role;
    if (kind === "user") break;
    if (kind !== "assistant") continue;
    const text = (m.content ?? [])
      .filter((c) => c?.type === "text" && c.text)
      .map((c) => c.text)
      .join("");
    if (text.trim()) out.unshift(text.trim());
  }
  return out.join("\n\n");
}

export function summarizeDiff(diff) {
  const rows = Array.isArray(diff) ? diff : diff?.data ?? [];
  return rows.slice(0, MAX_FILES).map((f) => ({
    file: f.file,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  }));
}

// Patches in diff order until the budget runs out, each clipped, so the
// review sees real code even when its read tools cannot reach a worktree.
export function patchExcerpt(diff, budget = PATCH_BUDGET) {
  const rows = Array.isArray(diff) ? diff : diff?.data ?? [];
  const out = [];
  let left = budget;
  for (const f of rows) {
    if (left <= 200 || !f?.patch) continue;
    const piece = clip(f.patch, Math.min(left, 2500));
    out.push(piece);
    left -= piece.length;
  }
  const omitted = rows.filter((f) => f?.patch).length - out.length;
  return out.join("\n") + (omitted > 0 ? `\n…[${omitted} more file patch(es) omitted]` : "");
}

function clip(s, n) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}\n…[${t.length - n} more chars]` : t;
}

export function buildReport(worker, { messages, diff, status, error, worktree } = {}) {
  const files = summarizeDiff(diff);
  return {
    sessionID: worker.sessionID,
    agent: worker.agent ?? "build",
    task: worker.task ?? "",
    round: worker.round ?? 0,
    chain: worker.chain ?? worker.sessionID,
    status: status ?? "ok",
    error: error ? clip(typeof error === "string" ? error : JSON.stringify(error), 400) : null,
    finalText: clip(finalAssistantText(messages), FINAL_TEXT_LIMIT),
    patch: patchExcerpt(diff),
    files,
    worktree: worktree?.state === "open" ? { branch: worktree.branch, base: worktree.base, directory: worktree.directory } : null,
    totals: files.reduce((t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { additions: 0, deletions: 0 }),
  };
}

// One-line deck summary: "reviewer finished · 3 files (+40 −2)".
export function reportHeadline(r) {
  const who = `${r.agent} ${r.status === "ok" ? "finished" : r.status}`;
  const files = r.files.length ? ` · ${r.files.length} file${r.files.length === 1 ? "" : "s"} (+${r.totals.additions} −${r.totals.deletions})` : " · no file changes";
  return `${who}${files}`;
}

export function buildReviewPrompt(report, { memories = [], registry = [] } = {}) {
  const canFollow = report.round < MAX_ROUNDS;
  const fileLines = report.files.length
    ? report.files.map((f) => `- ${f.status} ${f.file} (+${f.additions} −${f.deletions})`).join("\n")
    : "- (no file changes)";
  const memLine = memories.length ? `What you remember about the user:\n- ${memories.join("\n- ")}\n` : "";
  const fleetLine = registry.length ? `Fleet agents: ${registry.map((a) => a.id).join(", ")}.\n` : "";
  const wtLine = report.worktree
    ? `The work is isolated on branch ${report.worktree.branch} in worktree ${report.worktree.directory}, not yet in the user's checkout (${report.worktree.base}). Read changed files from that directory. When the chain is done and sound, tell the user they can say "land it" to merge, "keep it" to keep the branch, or "discard it".\n`
    : "";
  const actions = canFollow
    ? `Decide what happens next:
- Done and sound: tell the user the outcome in one or two sentences. No fence.
- Incomplete, wrong, or code changed but nothing was tested: send the SAME worker one follow-up with a single-line fence
\`\`\`followup {"task": "<what to do next>"}\`\`\`
- Needs a different specialist (e.g. a review after an implementation): \`\`\`dispatch {"task": "<self-contained instruction>", "agent": "<optional id>"}\`\`\`
Use at most one fence. You may read the changed files yourself to check the work.`
    : `This chain has used all ${MAX_ROUNDS} follow-up rounds. Do not emit any fence; tell the user where it stands and what they should decide.`;
  return `You are Jarvis reviewing a worker you delegated to. ${memLine}${fleetLine}
Worker: ${report.agent} (${report.sessionID.slice(0, 8)}), round ${report.round} of ${MAX_ROUNDS}
Task: ${report.task}
Outcome: ${report.status}${report.error ? ` — ${report.error}` : ""}
Files changed:
${fileLines}
${wtLine}
Worker's final message:
${report.finalText || "(empty)"}
${report.patch ? `\nDiff excerpt:\n${report.patch}\n` : ""}

${actions}`;
}

// Fetch the trailing messages and diff for a finished worker. Failures to
// fetch either degrade to an empty field; the report still goes out.
export async function collectWorkerReport(client, worker, { status, error, worktree } = {}) {
  const sessionID = worker.sessionID;
  const [messages, diff] = await Promise.all([
    client.message.list({ sessionID, limit: 30, order: "desc" })
      .then((r) => (r?.data ?? []).slice().reverse())
      .catch(() => []),
    client.session.diff({ sessionID }).catch(() => []),
  ]);
  return buildReport(worker, { messages, diff, status, error, worktree });
}
