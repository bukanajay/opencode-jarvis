// Meeting notes eval (Phase 5): does the brain turn a transcript into usable
// notes? Real model, a made-up English + Hinglish standup (none of your
// meetings are sent), checked for the decisions, owners and action items that
// were actually said, in English, with timestamps.
//
//   npm run eval:meeting-notes
//   npm run eval:meeting-notes -- --model opencode-go/claude-opus-5-5
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-eval-"));
process.env.JARVIS_STATE_ROOT = path.join(tmp, "projects");
process.env.JARVIS_PROJECTS_FILE = path.join(tmp, "projects.json");
process.env.JARVIS_MEMORY_FILE = path.join(tmp, "memory.json");
process.env.JARVIS_EMBED_OFF = "1";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const { brainAsk, brainRespond, setBrainModel, getBrainModel } = await import("../apps/main/src/brain/brain.js");
const { summaryPrompt, parseSummary, meetingContextBlock, recentMeetingsLine, pickMeeting } = await import("../apps/main/src/meetings-brain.js");
const model = arg("--model");
if (model) await setBrainModel(model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1));

const line = (start, speaker, text) => ({ start, end: start + 6, speaker, text });
const meeting = {
  id: "eval", status: "done", startedAt: new Date().toISOString(), seconds: 420,
  speakers: [{ id: "S1", label: "Pranshu" }, { id: "S2", label: "Neha" }],
  transcript: [
    line(5, "You", "Okay let's start. Pranshu, inferPulse ka status kya hai?"),
    line(14, "Pranshu", "Sir, specs aur documentation complete ho gaye hain. Coding kal se start karunga."),
    line(31, "Neha", "The design review for the dashboard is on Thursday, I've sent the invite."),
    line(44, "You", "Good. Let's keep Thursday for the review, and we'll ship the beta next Monday, not this Friday."),
    line(60, "Pranshu", "Theek hai sir, Monday works."),
    line(75, "You", "Neha, can you write the release notes by Friday?"),
    line(84, "Neha", "Yes, I'll have them by Friday evening."),
    line(98, "You", "Aur main investor update draft kar dunga, Wednesday tak."),
    line(120, "Pranshu", "One thing, sir, we haven't decided whether we use Postgres or keep SQLite for the beta."),
    line(131, "You", "Let's decide that after the review. Okay, thanks everyone."),
  ],
};

const t0 = Date.now();
const r = await brainAsk(summaryPrompt(meeting, { userName: "Ajay" }));
if (r.status !== "ok") throw new Error(`brain ${r.status}: ${r.error ?? ""}`);
const s = parseSummary(r.text);
console.log(`model ${JSON.stringify(getBrainModel())} · ${(Date.now() - t0) / 1000}s`);
console.log(JSON.stringify(s, null, 2));

const low = (x) => String(x ?? "").toLowerCase();
const has = (arr, pred) => arr.some(pred);
const checks = [
  ["title", () => s.title && s.title !== "Meeting"],
  ["decision: review on Thursday or beta on Monday", () => has(s.decisions, (d) => /thursday|monday/.test(low(d.text)))],
  ["Pranshu owns starting the coding", () => has(s.actions, (a) => /pranshu/.test(low(a.owner)) && /cod/.test(low(a.task)))],
  ["Neha owns release notes by Friday", () => has(s.actions, (a) => /neha/.test(low(a.owner)) && /release notes/.test(low(a.task)) && /friday/.test(low(`${a.due} ${a.task}`)))],
  ["Ajay owns the investor update (said in Hinglish)", () => has(s.actions, (a) => /ajay|^you$/.test(low(a.owner)) && /investor/.test(low(a.task)))],
  ["open question: Postgres vs SQLite", () => has(s.questions, (q) => /postgres|sqlite/.test(low(q.text)))],
  ["timestamps on action items", () => s.actions.filter((a) => a.at).length >= 2],
  ["in English (no Hinglish words)", () => !/\b(?:karunga|kal se|theek|dunga|ka status)\b/.test(low(JSON.stringify(s)))],
];
// Talking about it: the context Main builds for a message about the meeting.
const withNotes = { ...meeting, title: s.title, summary: s };
const ask = async (q) => {
  if (pickMeeting(q, [withNotes]) !== "eval") throw new Error(`"${q}" was not taken as about the meeting`);
  const context = `${recentMeetingsLine([withNotes])}\n${meetingContextBlock(withNotes, q, { userName: "Ajay" })}`;
  return brainRespond(q, () => {}, { context, ephemeral: true });
};
const q1 = await ask("In the last meeting, what did Neha agree to do and by when?");
console.log(`\nQ1 reply: ${q1.reply}`);
checks.push(["answers from the transcript (release notes, Friday)", () => /release notes/i.test(q1.reply) && /friday/i.test(q1.reply)]);
checks.push(["does not act on a question", () => q1.dispatches.length === 0 && q1.actions.length === 0]);
const q2 = await ask("From the last meeting, create a Linear issue for Pranshu's coding task.");
console.log(`Q2 reply: ${q2.reply}\nQ2 dispatches: ${JSON.stringify(q2.dispatches)}`);
checks.push(["delegates the Linear issue to a worker", () => q2.dispatches.some((d) => /linear/i.test(d.task) && /pranshu|inferpulse|cod/i.test(d.task))]);

let failed = 0;
for (const [name, ok] of checks) {
  const pass = (() => { try { return !!ok(); } catch { return false; } })();
  if (!pass) failed += 1;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${checks.length - failed}/${checks.length}`);
process.exit(failed ? 1 : 0);
