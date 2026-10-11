// Routines: standing goals Jarvis runs on its own while the app is open
// (window closed included). "Brief me every weekday at 8:30", "every hour,
// check CI on main and tell me only if it is red". Stored in
// ~/.config/jarvis/routines.json; schedule math is pure (injected clock).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KINDS = ["brief", "prompt"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function routinesPath() {
  return process.env.JARVIS_ROUTINES_FILE ?? path.join(os.homedir(), ".config", "jarvis", "routines.json");
}

export function loadRoutines(file = routinesPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, routines: Array.isArray(raw?.routines) ? raw.routines : [] };
  } catch {
    return { file, routines: [] };
  }
}

export function saveRoutines(store) {
  fs.mkdirSync(path.dirname(store.file), { recursive: true });
  fs.writeFileSync(store.file, JSON.stringify({ routines: store.routines }, null, 2));
}

// "weekdays" | "daily" | "weekends" | ["mon","wed"] | [1,3] -> sorted day numbers (0 = Sunday)
export function parseDays(days) {
  if (days == null || days === "daily" || days === "every day") return [0, 1, 2, 3, 4, 5, 6];
  if (days === "weekdays") return [1, 2, 3, 4, 5];
  if (days === "weekends") return [0, 6];
  const list = Array.isArray(days) ? days : String(days).split(/[\s,]+/);
  const out = new Set();
  for (const d of list) {
    if (typeof d === "number" && d >= 0 && d <= 6) { out.add(d); continue; }
    const i = DAY_NAMES.indexOf(String(d).toLowerCase().slice(0, 3));
    if (i < 0) throw new Error(`unknown day: ${d}`);
    out.add(i);
  }
  if (!out.size) throw new Error("no days");
  return [...out].sort();
}

export function parseTime(t) {
  const m = String(t ?? "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new Error(`bad time: ${t}`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) throw new Error(`bad time: ${t}`);
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// Schedule: { at: "HH:MM", days: [0..6] } or { everyMinutes: n } (5..1440).
export function normalizeSchedule({ time, days, everyMinutes } = {}) {
  if (everyMinutes != null) {
    const n = Math.round(Number(everyMinutes));
    if (!(n >= 5 && n <= 1440)) throw new Error("every: 5 to 1440 minutes");
    return { everyMinutes: n };
  }
  return { at: parseTime(time), days: parseDays(days) };
}

// Next run strictly after `from` (ms). Local time.
export function nextRun(schedule, from) {
  if (schedule.everyMinutes) return from + schedule.everyMinutes * 60000;
  const [h, m] = schedule.at.split(":").map(Number);
  const d = new Date(from);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
    if (c.getTime() > from && schedule.days.includes(c.getDay())) return c.getTime();
  }
  return null;
}

// Due now: enabled and its next run (after the last run, or creation) has passed.
// A routine missed while the Mac slept runs once on wake, not once per missed slot.
export function dueRoutines(routines, now) {
  return routines.filter((r) => {
    if (!r.enabled) return false;
    const after = r.lastRun ?? r.createdAt ?? now;
    const n = nextRun(r.schedule, after);
    return n != null && n <= now;
  });
}

export function describeSchedule(s) {
  if (s.everyMinutes) return s.everyMinutes % 60 === 0 ? `every ${s.everyMinutes / 60}h` : `every ${s.everyMinutes} min`;
  const days = s.days.join(",") === "1,2,3,4,5" ? "weekdays" : s.days.length === 7 ? "daily" : s.days.join(",") === "0,6" ? "weekends" : s.days.map((d) => DAY_NAMES[d]).join(",");
  return `${days} at ${s.at}`;
}

export function addRoutine(store, { title, kind = "prompt", prompt = "", time, days, everyMinutes }, now = Date.now()) {
  const t = String(title ?? "").trim().slice(0, 80);
  if (!t) throw new Error("routine: title required");
  if (!KINDS.includes(kind)) throw new Error(`routine: kind is ${KINDS.join("|")}`);
  if (kind === "prompt" && !String(prompt).trim()) throw new Error("routine: prompt required");
  const schedule = normalizeSchedule({ time, days, everyMinutes });
  const r = {
    id: `rt_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: t,
    kind,
    prompt: String(prompt).trim().slice(0, 2000),
    schedule,
    enabled: true,
    createdAt: now,
    lastRun: null,
  };
  store.routines.push(r);
  saveRoutines(store);
  return r;
}

// By id, or by title (exact, then unique substring).
export function findRoutine(store, ref) {
  const want = String(ref ?? "").trim().toLowerCase();
  const byId = store.routines.find((r) => r.id === ref);
  if (byId) return byId;
  const exact = store.routines.filter((r) => r.title.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const loose = store.routines.filter((r) => r.title.toLowerCase().includes(want));
  return loose.length === 1 ? loose[0] : null;
}

export function routinesSummary(routines, now = Date.now()) {
  if (!routines.length) return "Routines: none.";
  return `Routines: ${routines.map((r) => {
    const n = r.enabled ? nextRun(r.schedule, Math.max(now, r.lastRun ?? 0)) : null;
    return `${r.title} [${r.kind}, ${describeSchedule(r.schedule)}${r.enabled ? "" : ", paused"}${n ? `, next ${new Date(n).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}]`;
  }).join("; ")}.`;
}
