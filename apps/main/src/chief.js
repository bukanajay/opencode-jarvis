// Chief-of-staff loop: the decision inbox (refresh, broadcast, notify), the
// routine scheduler, the brief and stand-down. Main injects every side effect
// (brain, speech, notifications, fleet), so this stays testable with fakes.
import { buildInbox, inboxKey, newItems } from "./inbox.js";
import { loadRoutines, saveRoutines, dueRoutines, addRoutine, findRoutine, routinesSummary } from "./routines.js";
import { gitActivity, briefFacts, briefPrompt } from "./brief.js";

export function createChief(deps) {
  const {
    inboxSources, // () => sources for buildInbox
    broadcast, // (msg) => void
    onInbox = () => {}, // (items, fresh) => void   (tray badge, notifications)
    brain, // async (prompt, { context }) => { reply, speak?, status }
    context = () => "", // () => deck state for the brain
    speak = () => {}, // (text, { force }) => void
    notify = () => {}, // (title, body) => void
    runPrompt, // async (text) => void   (a routine's prompt through the normal path)
    workers = () => [], // () => snapshot
    projects = () => [], // () => recent projects
    userName = () => "",
    stopWorkers = async () => 0, // stand-down: stop running workers, return how many
    hush = () => {},
    now = () => Date.now(),
    lastBriefAt = { value: 0 }, // persisted by Main if it wants
    routinesFile,
    briefExtra = () => "", // () => extra fact lines (connected systems)
  } = deps;

  let inbox = [];
  let key = "";
  let timer = null;
  let briefing = false;

  function refreshInbox() {
    let next;
    try { next = buildInbox(inboxSources()); } catch { return inbox; }
    const k = inboxKey(next);
    if (k !== key) {
      const fresh = newItems(inbox, next);
      inbox = next;
      key = k;
      broadcast({ kind: "inbox.changed", items: inbox });
      onInbox(inbox, fresh);
    }
    return inbox;
  }

  const store = () => loadRoutines(routinesFile);

  async function brief({ reason = "asked", spoken = true } = {}) {
    if (briefing) return { ok: false, reason: "a brief is already running" };
    briefing = true;
    try {
      const t = now();
      const since = lastBriefAt.value || t - 24 * 3600 * 1000;
      const facts = briefFacts({
        now: t,
        userName: userName(),
        sinceMs: since,
        git: await gitActivity(projects(), since),
        workers: workers(),
        inbox: refreshInbox(),
        routinesLine: [routinesSummary(store().routines, t), briefExtra()].filter(Boolean).join("\n"),
      });
      broadcast({ kind: "session.stream", delta: `[brief] ${reason === "asked" ? "" : `${reason} · `}since ${new Date(since).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit" })}\n` });
      const r = await brain(briefPrompt(facts, { userName: userName() }), { context: context() });
      broadcast({ kind: "session.done", status: r.status ?? "ok" });
      lastBriefAt.value = t;
      const line = r.speak ?? null;
      if (line) speak(line, { force: spoken });
      notify("Your brief is ready", line ?? String(r.reply ?? "").split("\n")[0], { full: r.reply });
      return { ok: true, reply: r.reply, facts };
    } finally {
      briefing = false;
    }
  }

  async function runRoutine(r) {
    if (r.kind === "brief") return brief({ reason: r.title, spoken: true });
    broadcast({ kind: "session.stream", delta: `[routine] ${r.title}\n` });
    await runPrompt(`(Routine "${r.title}", running on its own; report briefly and only what matters.) ${r.prompt}`);
    return { ok: true };
  }

  async function tick() {
    refreshInbox();
    const s = store();
    const due = dueRoutines(s.routines, now());
    if (!due.length) return [];
    for (const r of due) r.lastRun = now();
    saveRoutines(s);
    for (const r of due) {
      try { await runRoutine(r); }
      catch (err) { broadcast({ kind: "session.stream", delta: `\n[routine] ${r.title} failed: ${String(err.message ?? err).slice(0, 120)}\n` }); }
    }
    return due.map((r) => r.id);
  }

  // Routine actions from the brain (actions.js "routine").
  function routineOp(a) {
    const s = store();
    if (a.op === "add") {
      const r = addRoutine(s, { title: a.title, kind: a.kind, prompt: a.prompt, time: a.time, days: a.days, everyMinutes: a.every }, now());
      return { ok: true, routine: r, line: `routine "${r.title}" added` };
    }
    const all = /^(all|everything|every routine)$/i.test(a.title);
    const targets = all ? s.routines : [findRoutine(s, a.title)].filter(Boolean);
    if (!targets.length) return { ok: false, reason: `no routine matches "${a.title}"` };
    if (a.op === "run") {
      for (const r of targets) runRoutine(r).catch(() => {});
      return { ok: true, line: `running ${targets.map((r) => r.title).join(", ")}` };
    }
    if (a.op === "remove") s.routines = s.routines.filter((r) => !targets.includes(r));
    else for (const r of targets) { r.enabled = a.op === "resume"; if (a.op === "resume") r.lastRun = now(); }
    saveRoutines(s);
    const verb = { remove: "removed", pause: "paused", resume: "resumed" }[a.op];
    return { ok: true, line: `${verb} ${targets.map((r) => r.title).join(", ")}` };
  }

  // Emergency stop: running workers stopped, every routine paused, silence.
  async function standDown() {
    hush();
    const stopped = await stopWorkers();
    const s = store();
    const paused = s.routines.filter((r) => r.enabled);
    for (const r of paused) r.enabled = false;
    saveRoutines(s);
    const line = `Standing down. Stopped ${stopped} worker${stopped === 1 ? "" : "s"} and paused ${paused.length} routine${paused.length === 1 ? "" : "s"}.`;
    broadcast({ kind: "session.stream", delta: `\n[jarvis] ${line}\n` });
    return { ok: true, stopped, paused: paused.length, line };
  }

  return {
    start(intervalMs = 30000) { if (!timer) timer = setInterval(() => tick().catch(() => {}), intervalMs); refreshInbox(); },
    stop() { clearInterval(timer); timer = null; },
    inbox: () => inbox,
    refreshInbox,
    brief,
    tick,
    routineOp,
    standDown,
  };
}
