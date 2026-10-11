import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildInbox, inboxKey, newItems, inboxSummary } from "../../apps/main/src/inbox.js";
import { parseDays, parseTime, normalizeSchedule, nextRun, dueRoutines, describeSchedule, addRoutine, findRoutine, loadRoutines } from "../../apps/main/src/routines.js";
import { isBriefRequest, briefFacts, briefPrompt } from "../../apps/main/src/brief.js";
import { createChief } from "../../apps/main/src/chief.js";
import { validateAction } from "../../apps/main/src/actions.js";

test("buildInbox: one queue, most urgent first, finished branches only", () => {
  const workers = new Map([["ses_a", { agent: "build", task: "check claude" }]]);
  const items = buildInbox({
    permissions: [{ requestID: "per_1", sessionID: "ses_a", action: "bash", resources: ["command -v claude"], at: 5 }],
    configs: [{ pendingID: "cfg_1", summary: "allow bash for reviewer", at: 1 }],
    bootstraps: [{ id: "boot_1", name: "sql-reviewer", prompt: "Which provider?" }],
    forms: [],
    chains: [
      { chainID: "ses_c", branch: "jarvis/fix", state: "open", busy: false, task: "fix parser" },
      { chainID: "ses_d", branch: "jarvis/busy", state: "open", busy: true },
      { chainID: "ses_e", branch: "jarvis/landed", state: "landed" },
    ],
    workers,
  });
  assert.deepEqual(items.map((i) => i.kind), ["permission", "config", "agent", "branch"]);
  assert.equal(items[0].title, "build wants bash");
  assert.equal(items[0].detail, "command -v claude");
  assert.deepEqual(items[3].actions, ["land", "keep", "discard"]);
  assert.match(inboxSummary(items), /Decision inbox \(4, only the user decides\)/);
  assert.equal(inboxSummary([]), "Decision inbox: empty.");
  assert.deepEqual(newItems(items.slice(1), items).map((i) => i.id), ["perm:per_1"]);
  assert.notEqual(inboxKey(items), inboxKey(items.slice(1)));
});

test("schedule parsing", () => {
  assert.deepEqual(parseDays("weekdays"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays(["Mon", "wed", "FRIDAY"]), [1, 3, 5]);
  assert.throws(() => parseDays(["funday"]), /unknown day/);
  assert.equal(parseTime("8:30"), "08:30");
  assert.equal(parseTime("6pm"), "18:00");
  assert.equal(parseTime("12am"), "00:00");
  assert.throws(() => parseTime("25:00"), /bad time/);
  assert.deepEqual(normalizeSchedule({ everyMinutes: 60 }), { everyMinutes: 60 });
  assert.throws(() => normalizeSchedule({ everyMinutes: 1 }), /5 to 1440/);
  assert.equal(describeSchedule({ at: "08:30", days: [1, 2, 3, 4, 5] }), "weekdays at 08:30");
  assert.equal(describeSchedule({ everyMinutes: 120 }), "every 2h");
});

test("nextRun / dueRoutines: weekday mornings, sleep-safe", () => {
  const fri = new Date(2026, 9, 9, 9, 0).getTime(); // Fri 9 Oct 2026 09:00 local
  const s = { at: "08:30", days: [1, 2, 3, 4, 5] };
  assert.equal(new Date(nextRun(s, fri)).toDateString(), new Date(2026, 9, 12).toDateString(), "Friday after 8:30 -> Monday");
  assert.equal(new Date(nextRun(s, fri)).getHours(), 8);
  const r = { enabled: true, schedule: s, createdAt: new Date(2026, 9, 8, 20, 0).getTime(), lastRun: null };
  assert.equal(dueRoutines([r], fri).length, 1, "Thursday-night routine is due Friday 09:00");
  r.lastRun = new Date(2026, 9, 9, 8, 30).getTime();
  assert.equal(dueRoutines([r], fri).length, 0, "already ran today");
  const monLate = new Date(2026, 9, 14, 12, 0).getTime(); // asleep Mon+Tue mornings
  assert.equal(dueRoutines([r], monLate).length, 1, "missed slots run once on wake");
  assert.equal(dueRoutines([{ ...r, enabled: false }], monLate).length, 0);
});

test("routine store: add, find", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rt-")), "routines.json");
  const store = loadRoutines(file);
  const r = addRoutine(store, { title: "Morning brief", kind: "brief", time: "8:30", days: "weekdays" }, 1000);
  assert.equal(r.schedule.at, "08:30");
  addRoutine(store, { title: "CI watch", kind: "prompt", prompt: "check CI on main", everyMinutes: 60 }, 2000);
  assert.equal(loadRoutines(file).routines.length, 2, "persisted");
  assert.equal(findRoutine(store, "ci")?.title, "CI watch");
  assert.equal(findRoutine(store, "nope"), null);
  assert.throws(() => addRoutine(store, { title: "x", kind: "prompt", time: "9:00" }), /prompt required/);
});

test("isBriefRequest + briefFacts + briefPrompt", () => {
  for (const t of ["Good morning, Jarvis.", "brief me", "what did I miss?", "catch me up", "give me my morning briefing"]) assert.ok(isBriefRequest(t), t);
  assert.ok(!isBriefRequest("good morning, can you fix the parser"));
  const facts = briefFacts({
    now: new Date(2026, 9, 12, 8, 30).getTime(),
    sinceMs: new Date(2026, 9, 11, 8, 30).getTime(),
    userName: "Ajay",
    git: [{ name: "opencode-jarvis", branch: "master", commits: ["abc123 Ajay: fix voice"], uncommitted: 2 }],
    workers: [{ state: "failed", task: "check git status" }, { state: "done", task: "find muse model" }, { state: "working", task: "fix parser" }],
    inbox: [{ title: "build wants bash", detail: "command -v claude" }],
    routinesLine: "Routines: Morning brief [brief, weekdays at 08:30].",
  });
  assert.match(facts, /Waiting on the user \(1\):\n- build wants bash — command -v claude/);
  assert.match(facts, /Fleet: 1 running, 1 finished, 1 failed/);
  assert.match(facts, /Project opencode-jarvis \(master\): 1 commit\(s\) since then, 2 uncommitted/);
  assert.match(briefPrompt(facts, { userName: "Ajay" }), /Give Ajay their brief/);
});

function fakeChief(over = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chief-")), "routines.json");
  const log = { broadcast: [], spoken: [], prompts: [], notified: [], inbox: [] };
  let t = new Date(2026, 9, 12, 8, 31).getTime();
  const chief = createChief({
    routinesFile: file,
    inboxSources: () => over.sources ?? {},
    broadcast: (m) => log.broadcast.push(m),
    onInbox: (items, fresh) => log.inbox.push([items.length, fresh.length]),
    brain: async () => ({ reply: "All quiet.", speak: "All quiet, Ajay.", status: "ok" }),
    speak: (text, o) => log.spoken.push([text, o]),
    notify: (title) => log.notified.push(title),
    runPrompt: async (p) => log.prompts.push(p),
    stopWorkers: async () => 2,
    now: () => t,
    ...over,
  });
  return { chief, log, file, advance: (ms) => { t += ms; } };
}

test("chief: due routines run once; brief speaks and notifies", async () => {
  const { chief, log, advance } = fakeChief();
  chief.routineOp(validateAction({ action: "routine", op: "add", title: "Morning brief", kind: "brief", time: "08:30", days: "daily" }));
  chief.routineOp(validateAction({ action: "routine", op: "add", title: "CI watch", prompt: "check CI on main, tell me only if red", every: 30 }));
  assert.deepEqual(await chief.tick(), [], "nothing due right after creation");
  advance(31 * 60000);
  const ran = await chief.tick();
  assert.equal(ran.length, 1, "CI watch due after 30 minutes");
  assert.match(log.prompts[0], /Routine "CI watch"/);
  advance(24 * 3600000);
  const both = await chief.tick();
  assert.equal(both.length, 2, "next day: brief + CI watch");
  assert.deepEqual(log.spoken.at(-1), ["All quiet, Ajay.", { force: true }]);
  assert.ok(log.notified.includes("Your brief is ready"));
  assert.deepEqual(await chief.tick(), [], "not twice");
});

test("chief: routine ops, stand down pauses everything", async () => {
  const { chief } = fakeChief();
  chief.routineOp({ action: "routine", op: "add", title: "Morning brief", kind: "brief", time: "08:30" });
  chief.routineOp({ action: "routine", op: "add", title: "CI watch", kind: "prompt", prompt: "x", every: 30 });
  assert.equal(chief.routineOp({ action: "routine", op: "pause", title: "ci" }).line, "paused CI watch");
  assert.equal(chief.routineOp({ action: "routine", op: "nope", title: "zzz" }).ok, false);
  const r = await chief.standDown();
  assert.equal(r.stopped, 2);
  assert.equal(r.paused, 1, "only the still-enabled one");
  assert.match(r.line, /Stopped 2 workers and paused 1 routine/);
  assert.equal(chief.routineOp({ action: "routine", op: "resume", title: "all" }).line, "resumed Morning brief, CI watch");
  assert.equal(chief.routineOp({ action: "routine", op: "remove", title: "CI watch" }).line, "removed CI watch");
});

test("chief: inbox changes broadcast once, notify only new items", () => {
  const sources = { permissions: [{ requestID: "p1", sessionID: "s", action: "bash", resources: ["ls"] }], workers: new Map() };
  const { chief, log } = fakeChief({ sources });
  chief.refreshInbox();
  chief.refreshInbox();
  assert.equal(log.broadcast.filter((m) => m.kind === "inbox.changed").length, 1);
  assert.deepEqual(log.inbox, [[1, 1]]);
});

test("routine action validation", () => {
  assert.deepEqual(validateAction({ action: "routine", op: "add", title: "Morning brief", time: "08:30", days: "weekdays" }), { action: "routine", op: "add", title: "Morning brief", kind: "brief", time: "08:30", days: "weekdays" });
  assert.deepEqual(validateAction({ action: "routine", op: "add", title: "CI", prompt: "check CI", every: 60 }), { action: "routine", op: "add", title: "CI", kind: "prompt", prompt: "check CI", every: 60 });
  assert.throws(() => validateAction({ action: "routine", op: "add", title: "CI", prompt: "x", every: 2 }), /5\.\.1440/);
  assert.throws(() => validateAction({ action: "routine", op: "explode", title: "x" }), /op is/);
  assert.deepEqual(validateAction({ action: "standdown" }), { action: "standdown" });
});
