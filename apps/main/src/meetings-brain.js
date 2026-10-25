// Meetings, as the brain sees them (docs/MEETING-MODE.md, Phase 5). Pure:
// what goes into the brain's context, which meeting a message is about, the
// summary prompt and the parser for its answer, and the brief's meeting line.
//
// Privacy: recording and transcription stay on the Mac. A transcript reaches
// the brain model only when you ask about that meeting (Summarize, Discuss,
// or a message that refers to it); the brain always sees just a one-line
// list of recent meetings.

const pad2 = (n) => String(n).padStart(2, "0");
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}

// The people on a meeting, by the names it ended with (not You, not echo).
export function meetingPeople(meeting) {
  const named = (meeting.speakers ?? []).map((sp) => sp.label).filter((l) => l && !/^(Them|Speaker [A-Z])$/.test(l));
  return [...new Set(named.map((l) => l.replace(/\?$/, "")))];
}

function when(iso, now) {
  const d = new Date(iso);
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
  const day = days === 0 ? "today" : days === 1 ? "yesterday" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// One line per recent meeting, always in the brain's context (cheap, no transcript).
export function recentMeetingsLine(meetings, now = Date.now(), n = 5) {
  const done = meetings.filter((m) => m.status === "done").slice(0, n);
  if (!done.length) return "Meetings recorded: none yet.";
  const rows = done.map((m) => {
    const who = meetingPeople(m);
    const mins = Math.max(1, Math.round((m.seconds ?? 0) / 60));
    return `- [${m.id}] ${when(m.startedAt, now)}, ${mins} min${who.length ? `, with ${who.join(", ")}` : ""}${m.title ? `: ${m.title}` : ""}`;
  });
  return `Meetings recorded on this Mac (newest first; ask about one to see its transcript):\n${rows.join("\n")}`;
}

const MEETING_WORDS = /\b(?:meetings?|calls?|stand-?ups?|syncs?|1:1|one[- ]on[- ]ones?|huddles?|catch-?ups?|transcripts?|discussion|what (?:did|was) (?:we|they|he|she) (?:say|said|decide|agree))\b/i;

// Which meeting a message is about: one it names by id, else the one you
// opened with Discuss (Main clears that focus after a while), else one whose
// person or title the message names, else the newest when the message talks
// about "the meeting". null when it is not about a meeting.
export function pickMeeting(text, meetings, focusId = null) {
  const t = String(text ?? "").toLowerCase();
  const done = meetings.filter((m) => m.status === "done");
  const byId = done.find((m) => t.includes(m.id));
  if (byId) return byId.id;
  if (focusId && done.some((m) => m.id === focusId)) return focusId;
  const aboutMeeting = MEETING_WORDS.test(t);
  const person = done.find((m) => meetingPeople(m).some((p) => new RegExp(`\\b${p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)));
  if (person && aboutMeeting) return person.id;
  const titled = done.find((m) => m.title && m.title.toLowerCase().split(/\W+/).filter((w) => w.length > 4).some((w) => t.includes(w)));
  if (titled && aboutMeeting) return titled.id;
  if (aboutMeeting && /\b(?:last|latest|recent|previous|today'?s|this morning'?s|that|the)\b/.test(t)) return done[0]?.id ?? null;
  return null;
}

const STOP = new Set("the a an and or but to of in on at for with is are was were be been it this that what who when how did do does we you i me my our they he she them his her about from as by so if then than there here just can could would should will".split(" "));
const words = (s) => String(s ?? "").toLowerCase().match(/[\p{L}\p{N}']+/gu)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? [];

// The transcript the brain gets: whole when it fits, else the lines that
// share words with the question (and their neighbours), in order.
export function transcriptFor(meeting, question, max = 14000) {
  const lines = meeting.transcript.map((s) => `[${clock(s.start)}] ${s.speaker}: ${s.text}`);
  const full = lines.join("\n");
  if (full.length <= max) return { text: full, excerpt: false };
  const q = new Set(words(question));
  const scored = meeting.transcript.map((s, i) => [i, words(s.text).filter((w) => q.has(w)).length]);
  const keep = new Set();
  for (const [i, score] of scored.sort((a, b) => b[1] - a[1])) {
    if (score === 0 && keep.size) break;
    for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k);
    const size = [...keep].reduce((n, k) => n + lines[k].length + 1, 0);
    if (size > max) { keep.delete(i); break; }
  }
  if (!keep.size) for (let k = 0; k < lines.length && [...keep].reduce((n, j) => n + lines[j].length + 1, 0) < max; k++) keep.add(k);
  let out = "", prev = -2;
  for (const k of [...keep].sort((a, b) => a - b)) {
    if (k !== prev + 1) out += "…\n";
    out += `${lines[k]}\n`;
    prev = k;
  }
  return { text: out.trim(), excerpt: true, shown: keep.size, total: lines.length };
}

// What the brain gets when a message is about a meeting.
export function meetingContextBlock(meeting, question, { userName = "", now = Date.now() } = {}) {
  const who = meetingPeople(meeting);
  const head = `Meeting [${meeting.id}] ${when(meeting.startedAt, now)}, ${clock(meeting.seconds ?? 0)} long${who.length ? `, with ${who.join(", ")}` : ""}. "You" in the transcript is ${userName || "the user"}; "Them" / "Speaker A…" are unnamed people on the call. Quote times as [mm:ss] when you refer to something said.`;
  const s = meeting.summary;
  const sum = s ? [
    `Summary: ${s.summary}`,
    s.decisions?.length ? `Decisions:\n${s.decisions.map((d) => `- ${d.text}${d.at ? ` [${d.at}]` : ""}`).join("\n")}` : "",
    s.actions?.length ? `Action items:\n${s.actions.map((a) => `- ${a.owner}: ${a.task}${a.due ? ` (due ${a.due})` : ""}${a.at ? ` [${a.at}]` : ""}`).join("\n")}` : "",
    s.questions?.length ? `Open questions:\n${s.questions.map((q) => `- ${q.text}${q.at ? ` [${q.at}]` : ""}`).join("\n")}` : "",
  ].filter(Boolean).join("\n") : "";
  const t = transcriptFor(meeting, question);
  const note = t.excerpt ? `Transcript (excerpt: ${t.shown} of ${t.total} lines that match the question):` : "Transcript:";
  return `${head}\n${sum ? `${sum}\n` : ""}${note}\n${t.text}\n` +
    "To act on it (create issues, send follow-ups, put things on the calendar), delegate to a worker as usual; anything that writes to a connected system comes back to the user to approve.";
}

// Ask the brain for the meeting's notes as one JSON object.
export function summaryPrompt(meeting, { userName = "" } = {}) {
  const who = meetingPeople(meeting);
  return `Write the notes for this meeting as ONE JSON object and nothing else (no prose, no code fence):\n` +
    `{"title": "<3-8 words>", "summary": "<2-4 sentences>", "decisions": [{"text": "...", "at": "mm:ss"}], ` +
    `"actions": [{"owner": "<who>", "task": "<imperative, self-contained>", "due": "<only if said, else omit>", "at": "mm:ss"}], ` +
    `"questions": [{"text": "<left open>", "at": "mm:ss"}]}\n` +
    `Rules: only what was actually said; empty arrays when there is nothing; "at" is the [mm:ss] where it was said; owner is a person's name, "${userName || "You"}" for the user ("You" in the transcript), or "unassigned"; ` +
    `write in English even when the meeting mixes Hindi and English; ignore small talk and transcription noise.\n` +
    `Meeting: ${clock(meeting.seconds ?? 0)} long${who.length ? `, with ${who.join(", ")}` : ""}. "You" is ${userName || "the user"}.\n` +
    `Transcript:\n${transcriptFor(meeting, "", 60000).text}`;
}

const AT = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const items = (arr, map) => (Array.isArray(arr) ? arr : []).map(map).filter(Boolean).slice(0, 20);

// The brain's answer -> a clean summary, or throws. Tolerates a fenced or
// chatty reply around the object; drops malformed items rather than failing.
export function parseSummary(reply) {
  const t = String(reply ?? "");
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  let o;
  try { o = JSON.parse(t.slice(start, end + 1)); } catch (err) { throw new Error(`summary is not valid JSON: ${err.message}`); }
  const at = (v) => (typeof v === "string" && AT.test(v.trim()) ? v.trim() : undefined);
  const s = {
    title: clip(o.title, 80) || "Meeting",
    summary: clip(o.summary, 800),
    decisions: items(o.decisions, (d) => (d?.text ? { text: clip(d.text, 300), at: at(d.at) } : null)),
    actions: items(o.actions, (a) => (a?.task ? { owner: clip(a.owner || "unassigned", 60), task: clip(a.task, 300), due: a.due ? clip(a.due, 60) : undefined, at: at(a.at) } : null)),
    questions: items(o.questions, (q) => (q?.text ? { text: clip(q.text, 300), at: at(q.at) } : null)),
  };
  if (!s.summary) throw new Error("summary is empty");
  return s;
}

// The brief: meetings since then, and what you said you would do.
export function meetingsBriefLine(meetings, sinceMs, { userName = "", now = Date.now() } = {}) {
  const recent = meetings.filter((m) => m.status === "done" && Date.parse(m.startedAt) >= sinceMs);
  if (!recent.length) return "";
  const me = (o) => /^you$/i.test(o) || (userName && o.toLowerCase() === userName.toLowerCase());
  const lines = [`Meetings since then (${recent.length}):`];
  for (const m of recent.slice(0, 5)) {
    const who = meetingPeople(m);
    lines.push(`- ${when(m.startedAt, now)}${who.length ? ` with ${who.join(", ")}` : ""}: ${m.title ?? "not summarised yet"}`);
    for (const a of (m.summary?.actions ?? []).filter((a) => me(a.owner)).slice(0, 4)) lines.push(`  - you said you would: ${a.task}${a.due ? ` (due ${a.due})` : ""}`);
  }
  return lines.join("\n");
}
