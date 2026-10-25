import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clock, meetingContextBlock, meetingPeople, meetingsBriefLine, parseSummary, pickMeeting, recentMeetingsLine, summaryPrompt, transcriptFor,
} from "../../apps/main/src/meetings-brain.js";

const NOW = new Date(2026, 9, 26, 9, 0).getTime();
const seg = (start, speaker, text) => ({ start, end: start + 3, speaker, text, stream: speaker === "You" ? "mic" : "system" });
const standup = {
  id: "2026-10-25-1756", status: "done", startedAt: new Date(2026, 9, 25, 17, 56).toISOString(), seconds: 489,
  speakers: [{ id: "S1", label: "Pranshu" }],
  transcript: [
    seg(329, "You", "So what is the status for that inferPulse project? Did you implement anything?"),
    seg(352, "Pranshu", "I followed the specs and added the documentation only, from tomorrow I will implement the coding section."),
    seg(385, "Pranshu", "I have decided the looks and the UI things and implemented the prototype."),
    seg(405, "You", "Okay, thank you. When I make some progress I will share it with you all."),
  ],
};
const planning = {
  id: "2026-10-24-1000", status: "done", startedAt: new Date(2026, 9, 24, 10, 0).toISOString(), seconds: 1800,
  title: "Q4 roadmap planning", speakers: [{ id: "S1", label: "Speaker A" }, { id: "S2", label: "Moira?" }], transcript: [],
};
const meetings = [standup, planning];

test("meetingPeople: names only, unsure ones without the question mark", () => {
  assert.deepEqual(meetingPeople(standup), ["Pranshu"]);
  assert.deepEqual(meetingPeople(planning), ["Moira"]);
});

test("recentMeetingsLine: one line each, no transcript", () => {
  const line = recentMeetingsLine(meetings, NOW);
  assert.match(line, /\[2026-10-25-1756\] yesterday 17:56, 8 min, with Pranshu/);
  assert.match(line, /\[2026-10-24-1000\] .*30 min, with Moira: Q4 roadmap planning/);
  assert.equal(line.includes("inferPulse"), false, "the transcript never goes in the always-on line");
  assert.equal(recentMeetingsLine([], NOW), "Meetings recorded: none yet.");
});

test("pickMeeting: id, focus, person, title, 'the last meeting'; nothing for unrelated messages", () => {
  assert.equal(pickMeeting("summarise 2026-10-24-1000", meetings), "2026-10-24-1000");
  assert.equal(pickMeeting("what did Pranshu say in the call?", meetings), "2026-10-25-1756");
  assert.equal(pickMeeting("what came out of the roadmap meeting", meetings), "2026-10-24-1000");
  assert.equal(pickMeeting("recap the last meeting", meetings), "2026-10-25-1756");
  assert.equal(pickMeeting("anything I should follow up on?", meetings, "2026-10-24-1000"), "2026-10-24-1000", "Discuss focus wins");
  assert.equal(pickMeeting("fix the failing parser tests", meetings), null);
  assert.equal(pickMeeting("ask Pranshu to review my PR", meetings), null, "a name alone is not about a meeting");
});

test("transcriptFor: whole when it fits; long meetings get the lines that match the question", () => {
  assert.equal(transcriptFor(standup, "x").excerpt, false);
  const long = { ...standup, transcript: Array.from({ length: 400 }, (_, i) => seg(i * 5, i % 2 ? "Them" : "You", i === 200 ? "The migration review is blocked on the schema owner" : `filler line number ${i} about nothing much`)) };
  const t = transcriptFor(long, "what is blocking the migration review?", 1500);
  assert.equal(t.excerpt, true);
  assert.match(t.text, /\[16:40\] You: The migration review is blocked/);
  assert.ok(t.text.length <= 1600);
});

test("meetingContextBlock: who, summary, transcript, and how to act", () => {
  const block = meetingContextBlock({ ...standup, summary: { summary: "Status of inferPulse.", decisions: [], actions: [{ owner: "Pranshu", task: "Implement the coding section", at: "05:52" }], questions: [] } }, "status?", { userName: "Ajay", now: NOW });
  assert.match(block, /Meeting \[2026-10-25-1756\] yesterday 17:56, 08:09 long, with Pranshu\. "You" in the transcript is Ajay/);
  assert.match(block, /Action items:\n- Pranshu: Implement the coding section \[05:52\]/);
  assert.match(block, /\[05:52\] Pranshu: I followed the specs/);
  assert.match(block, /comes back to the user to approve/);
});

test("summaryPrompt: asks for one JSON object in English, names you", () => {
  const p = summaryPrompt(standup, { userName: "Ajay" });
  assert.match(p, /ONE JSON object/);
  assert.match(p, /English even when the meeting mixes Hindi and English/);
  assert.match(p, /"You" is Ajay/);
  assert.match(p, /\[05:52\] Pranshu:/);
});

test("parseSummary: tolerant of chatter and fences, strict on content", () => {
  const reply = 'Here are the notes:\n```json\n{"title":"inferPulse status","summary":"Pranshu has the specs and docs done; coding starts tomorrow.",' +
    '"decisions":[{"text":"Coding starts tomorrow","at":"05:52"},{"nope":1}],' +
    '"actions":[{"owner":"Pranshu","task":"Implement the coding section","due":"tomorrow","at":"5:52"},{"owner":"Ajay","task":"Share progress with the team","at":"bad"}],' +
    '"questions":[]}\n```';
  const s = parseSummary(reply);
  assert.equal(s.title, "inferPulse status");
  assert.deepEqual(s.decisions, [{ text: "Coding starts tomorrow", at: "05:52" }]);
  assert.deepEqual(s.actions.map((a) => [a.owner, a.task, a.due, a.at]), [["Pranshu", "Implement the coding section", "tomorrow", "5:52"], ["Ajay", "Share progress with the team", undefined, undefined]]);
  assert.throws(() => parseSummary("I could not summarise that."), /no JSON object/);
  assert.throws(() => parseSummary('{"title":"x","summary":""}'), /empty/);
});

test("meetingsBriefLine: meetings since then and what you said you would do", () => {
  const withNotes = { ...standup, title: "inferPulse status", summary: { actions: [{ owner: "Ajay", task: "Share progress with the team" }, { owner: "Pranshu", task: "Implement the coding section" }] } };
  const line = meetingsBriefLine([withNotes, planning], new Date(2026, 9, 25, 0, 0).getTime(), { userName: "Ajay", now: NOW });
  assert.match(line, /Meetings since then \(1\):\n- yesterday 17:56 with Pranshu: inferPulse status\n  - you said you would: Share progress with the team/);
  assert.equal(line.includes("Implement the coding section"), false, "only your own items");
  assert.equal(meetingsBriefLine(meetings, NOW, {}), "");
});

test("clock", () => {
  assert.equal(clock(352.7), "05:52");
  assert.equal(clock(3725), "1:02:05");
});
