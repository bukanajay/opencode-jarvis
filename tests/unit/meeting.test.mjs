import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chooseLine, hindiShare, assignSpeakers, createMeetingLog, echoVerdict, getMeeting, nameSpeaker, speakersToName, saveSummary, retranscribeMeeting, isMeetingActive, listMeetings, meetingId, speakerFor,
  startMeeting, stopMeeting, transcriptText,
} from "../../apps/main/src/meeting.js";

const seg = (o) => ({ id: o.id ?? Math.random().toString(36).slice(2), micDb: -30, systemDb: -120, micVoiced: 0.6, systemVoiced: 0, ...o });
const GOOD_EVENING = "Good evening, the build agent has fixed the parser and all 85 tests are passing.";

test("meetingId: local yyyy-mm-dd-hhmm", () => {
  assert.equal(meetingId(new Date(2026, 9, 25, 9, 5)), "2026-10-25-0905");
});

test("speakerFor: mic is You, system is Them", () => {
  assert.equal(speakerFor("mic"), "You");
  assert.equal(speakerFor("system"), "Them");
});

test("echoVerdict: mic repeating the call's words at the same time is echo", () => {
  const sys = [seg({ stream: "system", text: GOOD_EVENING, start: 3.8, end: 10.8 })];
  const mic = seg({ stream: "mic", text: "Good evening, the build agent has fixed the parser and all 85 tests are present.", start: 3.9, end: 10.7 });
  assert.equal(echoVerdict(mic, sys), "text");
});

test("echoVerdict: same words much later, or your own words, are not echo", () => {
  const sys = [seg({ stream: "system", text: GOOD_EVENING, start: 3.8, end: 10.8 })];
  assert.equal(echoVerdict(seg({ stream: "mic", text: GOOD_EVENING, start: 30, end: 36 }), sys), null);
  assert.equal(echoVerdict(seg({ stream: "mic", text: "Great, I will review it after lunch.", start: 4, end: 7 }), sys), null);
});

test("echoVerdict: a one-word echo needs the same word from the call at the same moment", () => {
  const sys = [seg({ stream: "system", text: "Who?", start: 456.2, end: 456.6 })];
  assert.equal(echoVerdict(seg({ stream: "mic", text: "Who", start: 456.3, end: 456.7 }), sys), "text");
  assert.equal(echoVerdict(seg({ stream: "mic", text: "Who", start: 457.4, end: 457.8 }), sys), null);
  assert.equal(echoVerdict(seg({ stream: "mic", text: "Okay.", start: 456.3, end: 456.7 }), sys), null);
});

test("echoVerdict: level rule needs a leaky route and a much quieter mic", () => {
  const quiet = seg({ stream: "mic", text: "uh huh okay", start: 1, end: 3, micDb: -55, systemDb: -15, systemVoiced: 0.9 });
  assert.equal(echoVerdict(quiet, [], { route: "speakers" }), "level");
  assert.equal(echoVerdict(quiet, [], { route: "headphones" }), null);
  const talking = { ...quiet, micDb: -24 }; // you talking over them
  assert.equal(echoVerdict(talking, [], { route: "speakers" }), null);
});

test("createMeetingLog: system arriving later turns an earlier mic segment into echo", () => {
  const log = createMeetingLog({ route: "speakers" });
  const mic = log.add(seg({ id: "m1", stream: "mic", text: GOOD_EVENING, start: 3.9, end: 10.7 }));
  assert.equal(mic[0].echo, null);
  const changed = log.add(seg({ id: "s1", stream: "system", text: GOOD_EVENING, start: 3.8, end: 10.8 }));
  assert.deepEqual(changed.map((s) => s.id), ["s1", "m1"]);
  assert.equal(changed[1].echo, "text");
  log.add(seg({ id: "m2", stream: "mic", text: "Great, I will review it after lunch.", start: 12, end: 14 }));
  assert.deepEqual(log.transcript().map((s) => `${s.speaker}:${s.id}`), ["Them:s1", "You:m2"]);
});

test("transcriptText: clock, speaker, words", () => {
  const text = transcriptText([
    { start: 3.8, speaker: "Them", text: "Hello." },
    { start: 3725, speaker: "You", text: "Bye." },
  ]);
  assert.equal(text, "[00:03] Them: Hello.\n[1:02:05] You: Bye.");
});

// A stand-in helper: speaks the meeting protocol, stops on a `stop` line.
// diarized: what `--diarize` answers (turns + speakers), default none.
function fakeHelper({ lines: extra = [], diarized = { turns: [], speakers: [] } } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-fake-parakeet-"));
  const bin = path.join(dir, "parakeet");
  const lines = [
    { kind: "status", state: "listening", note: "fake", route: "speakers" },
    { kind: "partial", stream: "mic", id: "m1", text: "Good evening", revision: 1 },
    { kind: "segment", stream: "mic", id: "m1", text: GOOD_EVENING, start: 3.9, end: 10.7, micDb: -23, systemDb: -14, micVoiced: 0.85, systemVoiced: 0.84 },
    { kind: "segment", stream: "system", id: "s1", text: GOOD_EVENING, start: 3.8, end: 10.8, micDb: -23, systemDb: -14, micVoiced: 0.85, systemVoiced: 0.84 },
    { kind: "segment", stream: "mic", id: "m2", text: "Great, I will review it after lunch.", start: 12.3, end: 15.4, micDb: -30, systemDb: -120, micVoiced: 0.5, systemVoiced: 0 },
    ...extra,
  ];
  writeFileSync(bin, `#!/usr/bin/env node
const lines = ${JSON.stringify(lines)};
if (process.argv.includes("--diarize")) {
  const d = ${JSON.stringify(diarized)};
  console.log(JSON.stringify({ kind: "turns", turns: d.turns }));
  for (const sp of d.speakers) console.log(JSON.stringify({ kind: "speaker", ...sp }));
  console.log(JSON.stringify({ kind: "status", state: "diarized", speakers: d.speakers.length }));
  process.exit(0);
}
const dir = process.argv[process.argv.indexOf("--meeting") + 1];
require("node:fs").writeFileSync(dir + "/args.json", JSON.stringify(process.argv.slice(2)));
for (const l of lines) console.log(JSON.stringify(l));
if (process.argv.includes("--replay-mic")) { // a replay ends by itself
  console.log(JSON.stringify({ kind: "status", state: "stopped", note: dir, seconds: 18.5 }));
  process.exit(0);
}
process.stdin.on("data", (d) => {
  if (String(d).includes("stop")) {
    console.log(JSON.stringify({ kind: "status", state: "stopped", note: dir, seconds: 18.5 }));
    process.exit(0);
  }
});
`);
  chmodSync(bin, 0o755);
  return bin;
}

test("startMeeting/stopMeeting: events, echo hidden, files written, one at a time", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jarvis-meetings-"));
  const events = [];
  const m = startMeeting({ bin: fakeHelper(), root, onEvent: (e) => events.push(e), now: new Date(2026, 9, 25, 14, 30) });
  assert.equal(m.id, "2026-10-25-1430");
  assert.equal(isMeetingActive(), true);
  assert.throws(() => startMeeting({ bin: fakeHelper(), root }), /already running/);

  await new Promise((r) => setTimeout(r, 300));
  const r = await stopMeeting();
  assert.equal(r.ok, true);
  assert.equal(r.status, "done");
  assert.equal(r.segments, 2);
  assert.equal(isMeetingActive(), false);

  const echoed = events.filter((e) => e.type === "segment" && e.segment.id === "m1").map((e) => e.segment.echo);
  assert.deepEqual(echoed, [null, "text"], "m1 shown, then hidden as echo");
  assert.ok(events.some((e) => e.type === "partial" && e.speaker === "You"));
  assert.equal(events.at(-1).type, "stopped");

  const got = getMeeting(m.id, root);
  assert.equal(got.status, "done");
  assert.equal(got.route, "speakers");
  assert.equal(got.seconds, 18.5);
  assert.equal(got.text, "[00:03] Them: " + GOOD_EVENING + "\n[00:12] You: Great, I will review it after lunch.");
  assert.ok(existsSync(path.join(m.dir, "segments.jsonl")));
  assert.equal(readFileSync(path.join(m.dir, "transcript.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.deepEqual(listMeetings(root).map((x) => x.id), [m.id]);

  // Same minute: a second meeting gets its own folder.
  const m2 = startMeeting({ bin: fakeHelper(), root, now: new Date(2026, 9, 25, 14, 30) });
  assert.equal(m2.id, "2026-10-25-1430-2");
  await stopMeeting();
});

test("startMeeting: whisper engine passes model and language, and is recorded", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jarvis-meetings-"));
  const model = path.join(root, "model.bin");
  writeFileSync(model, "x");
  const m = startMeeting({ bin: fakeHelper(), root, engine: "whisper", model });
  await new Promise((r) => setTimeout(r, 300));
  await stopMeeting();
  const args = JSON.parse(readFileSync(path.join(m.dir, "args.json"), "utf8"));
  assert.deepEqual(args.slice(args.indexOf("--engine")), ["--engine", "whisper", "--model", model, "--language", "hi"]);
  assert.equal(getMeeting(m.id, root).engine, "whisper");
});

test("startMeeting: parakeet is the default; bad engine or missing model are clear errors", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jarvis-meetings-"));
  const m = startMeeting({ bin: fakeHelper(), root });
  await new Promise((r) => setTimeout(r, 300));
  await stopMeeting();
  assert.ok(!JSON.parse(readFileSync(path.join(m.dir, "args.json"), "utf8")).includes("--engine"));
  assert.equal(getMeeting(m.id, root).engine, "parakeet");
  assert.throws(() => startMeeting({ bin: fakeHelper(), root, engine: "bogus" }), /unknown speech engine/);
  assert.throws(() => startMeeting({ bin: fakeHelper(), root, engine: "whisper", model: "/nope.bin" }), /fetch:whisper-model/);
  assert.equal(isMeetingActive(), false);
});

test("assignSpeakers: overlap, then voiceprint, then nearest turn; names, letters, or Them", () => {
  const P = (i) => Array.from({ length: 256 }, (_, k) => (k === i ? 1 : 0));
  const turns = [
    { speaker: "S2", start: 1, end: 5 }, { speaker: "S1", start: 6, end: 10 }, { speaker: "S2", start: 11, end: 14 },
  ];
  const speakers = [
    { id: "S1", seconds: 4, print: P(1), voices: [{ id: "me", score: 0.9 }, { id: "p-ravi", score: 0.2 }] },
    { id: "S2", seconds: 7, print: P(2), voices: [{ id: "p-ravi", score: 0.1 }] },
  ];
  const segs = [
    { id: "a", stream: "system", start: 1.2, end: 4.8 },             // inside an S2 turn
    { id: "b", stream: "system", start: 6.1, end: 9.5 },             // inside S1
    { id: "c", stream: "system", start: 20, end: 21, print: P(1) },  // no turn: its voiceprint says S1
    { id: "d", stream: "system", start: 15.5, end: 16 },             // no turn, no print: nearest turn (S2, 1.5 s)
    { id: "e", stream: "system", start: 40, end: 41 },               // nothing near: stays Them
    { id: "f", stream: "mic", start: 2, end: 3 },                    // your side is not touched
  ];
  const { speakers: named, who } = assignSpeakers(segs, { turns, speakers }, [{ id: "p-ravi", name: "Ravi" }]);
  assert.deepEqual(named.map((s) => [s.id, s.label]), [["S2", "Speaker A"], ["S1", "Speaker B"]], "lettered by first turn; a 'me' match never names a call voice");
  assert.deepEqual([...who].map(([k, v]) => `${k}:${v.id}`), ["a:S2", "b:S1", "c:S1", "d:S2"]);

  const known = assignSpeakers(segs, { turns, speakers: [{ ...speakers[1], voices: [{ id: "p-ravi", score: 0.71 }] }, speakers[0]] }, [{ id: "p-ravi", name: "Ravi" }]);
  assert.deepEqual(known.speakers.map((s) => [s.id, s.label, s.match?.name]), [["S2", "Ravi", "Ravi"], ["S1", "Them", undefined]], "one unknown voice stays Them");
});

test("stopMeeting: the call side is told apart before the transcript is written", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jarvis-meetings-"));
  const P = (i) => Array.from({ length: 256 }, (_, k) => (k === i ? 1 : 0));
  const bin = fakeHelper({
    lines: [{ kind: "segment", stream: "system", id: "s2", text: "And the migration needs one more review.", start: 16, end: 19, micDb: -120, systemDb: -15, micVoiced: 0, systemVoiced: 0.8 }],
    diarized: {
      turns: [{ speaker: "S1", start: 3.7, end: 10.9 }, { speaker: "S2", start: 15.8, end: 19.2 }],
      speakers: [{ id: "S1", seconds: 7.2, turns: 1, print: P(1), voices: [], clip: "/x/S1.wav" }, { id: "S2", seconds: 3.4, turns: 1, print: P(2), voices: [] }],
    },
  });
  const events = [];
  const m = startMeeting({ bin, root, onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 300));
  const r = await stopMeeting();
  assert.equal(r.status, "done");
  assert.equal(r.speakers, 2);
  assert.ok(events.some((e) => e.type === "status" && e.state === "diarizing"));
  const relabelled = events.filter((e) => e.type === "segment" && e.segment.stream === "system").map((e) => `${e.segment.id}:${e.segment.speaker}`);
  assert.deepEqual(relabelled.slice(-2), ["s1:Speaker A", "s2:Speaker B"]);
  const got = getMeeting(m.id, root);
  assert.deepEqual(got.transcript.map((s) => s.speaker), ["Speaker A", "You", "Speaker B"]);
  assert.deepEqual(got.speakers.map((s) => [s.id, s.label]), [["S1", "Speaker A"], ["S2", "Speaker B"]]);
  assert.equal(JSON.stringify(got.speakers).includes("print"), false, "voiceprints only in speakers.json");
  assert.equal(JSON.parse(readFileSync(path.join(m.dir, "speakers.json"), "utf8"))[0].print.length, 256);
});

test("assignSpeakers: one voice on the call owns every call-side line, even far from its turns", () => {
  const { who } = assignSpeakers(
    [{ id: "far", stream: "system", start: 200, end: 201 }, { id: "mine", stream: "mic", start: 200, end: 201 }],
    { turns: [{ speaker: "S1", start: 352, end: 364 }], speakers: [{ id: "S1", seconds: 12 }] },
  );
  assert.deepEqual([...who].map(([k, v]) => `${k}:${v.id}`), ["far:S1"]);
});

test("chooseLine: the real call's lines, English from Parakeet, Hinglish from Whisper", () => {
  const pick = (parakeet, whisper) => { const r = chooseLine({ parakeet, whisper }); return [r.engine, r.text]; };
  // English: Parakeet hears it better.
  assert.deepEqual(pick("Uh so right now uh I followed the specs and added the documentations only", "Sir right now I followed the steps and added the documentation only"),
    ["parakeet", "Uh so right now uh I followed the specs and added the documentations only"]);
  assert.deepEqual(pick("Is there like any uh tech stack related selection", "Is there like any text type related selection")[0], "parakeet");
  assert.deepEqual(pick("Okay, okay, okay, okay", "Ok ok ok ok.")[0], "parakeet");
  // Hinglish: Whisper.
  assert.deepEqual(pick("Meeting me uh test curvath. Thank you. Progress or yang to share karma to m lo we saw bigger dictionary.",
    "Jab main thoda progress ho jaoonga to share kar loonga tum logon ke saath bhi agar dekhana hai.")[0], "whisper");
  assert.deepEqual(pick("Mm-hmm.", "Thik hai."), ["whisper", "Thik hai."]);
  assert.deepEqual(pick("Mm-hmm.", "Ji ji."), ["whisper", "Ji ji."]);
  // Parakeet drifting into Spanish / German / Russian on Hindi it could not follow.
  assert.deepEqual(pick("Y lo que sí, no que", "Ok sir. Ok."), ["whisper", "Ok sir. Ok."]);
  assert.deepEqual(pick("Ich gehe. Gut, aber da, gell?", "Ok sir, ok.")[0], "whisper");
  assert.deepEqual(pick("Ну", "Ok.")[0], "whisper");
  // Only one heard anything; Devanagari-only Whisper output is noise.
  assert.deepEqual(pick("", "Hello."), ["whisper", "Hello."]);
  assert.deepEqual(pick("", "जाज"), [null, ""]);
  assert.deepEqual(pick("Okay.", "जाज"), ["parakeet", "Okay."]);
  assert.deepEqual(pick("Okay.", ""), ["parakeet", "Okay."]);
  assert.equal(chooseLine({ parakeet: "Okay.", whisper: "Thik hai." }).alt, "Okay.", "the other engine's line is kept");
  assert.deepEqual(hindiShare("Ok, abhi baat kar lenge baad mein"), { hits: 6, words: 7, share: 6 / 7 });
});

test("meeting log (hybrid): keeps the chosen line, the other engine's as alt; noise to both is dropped", () => {
  const log = createMeetingLog({ route: "speakers" });
  const [hinglish] = log.add(seg({ stream: "mic", start: 435, end: 441, text: "Meeting me uh test curvath.", texts: { parakeet: "Meeting me uh test curvath.", whisper: "Jab main thoda progress ho jaoonga to share kar loonga." }, voices: [{ id: "me", score: 0.9 }] }));
  assert.equal(hinglish.text, "Jab main thoda progress ho jaoonga to share kar loonga.");
  assert.equal(hinglish.engine, "whisper");
  assert.equal(hinglish.alt, "Meeting me uh test curvath.");
  const [english] = log.add(seg({ stream: "system", start: 352, end: 364, text: "I followed the specs", texts: { parakeet: "I followed the specs", whisper: "I followed the steps" } }));
  assert.equal(english.text, "I followed the specs");
  assert.equal(english.engine, "parakeet");
  assert.deepEqual(log.add(seg({ stream: "system", start: 214, end: 215, text: "", texts: { parakeet: "", whisper: "जाज" } })), []);
  assert.equal(log.all().length, 2);
});

test("assignSpeakers: a close-but-unsure match reads as a question", () => {
  const { speakers } = assignSpeakers([], { turns: [{ speaker: "S1", start: 0, end: 4 }], speakers: [{ id: "S1", voices: [{ id: "p-ravi", score: 0.42 }] }] }, [{ id: "p-ravi", name: "Ravi" }]);
  assert.equal(speakers[0].label, "Ravi?");
  assert.equal(speakers[0].match.uncertain, true);
});

// A finished meeting with two unknown call-side voices, through the real
// stop path and a fake helper.
async function meetingWithVoices(root, voices, prints, now) {
  const bin = fakeHelper({
    lines: [{ kind: "segment", stream: "system", id: "s2", text: "And the migration needs one more review.", start: 16, end: 19, micDb: -120, systemDb: -15, micVoiced: 0, systemVoiced: 0.8 }],
    diarized: {
      turns: [{ speaker: "S1", start: 3.7, end: 10.9 }, { speaker: "S2", start: 15.8, end: 19.2 }],
      speakers: [
        { id: "S1", seconds: 7.2, turns: 1, print: prints[0], voices: [], clip: "/x/S1.wav" },
        { id: "S2", seconds: 2.4, turns: 1, print: prints[1], voices: [], clip: "/x/S2.wav" },
      ],
    },
  });
  const m = startMeeting({ bin, root, voices, now });
  await new Promise((r) => setTimeout(r, 300));
  const r = await stopMeeting();
  return { m, r };
}

test("nameSpeaker: remembered, this meeting relabelled, and an older one with the same voice", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jarvis-meetings-"));
  const voices = path.join(root, "people.json");
  const P = (i) => Array.from({ length: 256 }, (_, k) => (k === i ? 1 : 0));
  const first = await meetingWithVoices(root, voices, [P(1), P(2)], new Date(2026, 9, 25, 9, 0));
  const second = await meetingWithVoices(root, voices, [P(2), P(5)], new Date(2026, 9, 26, 9, 0));
  assert.equal(second.r.toName, 1, "only S1 has enough speech to be worth asking about");

  const ask = speakersToName(getMeeting(second.m.id, root));
  assert.deepEqual(ask.map((s) => [s.id, s.label, s.said]), [["S1", "Speaker A", GOOD_EVENING]]);

  // In the second meeting, S1 is the voice that was S2 in the first.
  const r = nameSpeaker(second.m.id, "S1", { name: "Moira" }, { root, voices });
  assert.equal(r.person.name, "Moira");
  assert.deepEqual(r.meeting.transcript.map((s) => s.speaker), ["Moira", "You", "Speaker B"]);
  assert.deepEqual(speakersToName(r.meeting), [], "named speakers are not asked about again");
  const older = getMeeting(first.m.id, root);
  assert.deepEqual(older.transcript.map((s) => s.speaker), ["Speaker A", "You", "Moira"], "the same voice in the older meeting");
  assert.equal(older.speakers.find((s) => s.id === "S2").named, undefined, "matched, not confirmed by you");
  assert.equal(r.relabelled, 2);

  // Renaming the person carries through on the next relabel; a named speaker
  // in a meeting keeps the person even if a closer voice appears later.
  const { renameVoice } = await import("../../apps/main/src/voices.js");
  renameVoice(r.person.id, "Moira K", voices);
  const again = nameSpeaker(first.m.id, "S1", { name: "Daniel" }, { root, voices });
  assert.deepEqual(again.meeting.transcript.map((s) => s.speaker), ["Daniel", "You", "Moira K"]);
  assert.deepEqual(getMeeting(second.m.id, root).transcript.map((s) => s.speaker), ["Moira K", "You", "Speaker B"]);
  assert.throws(() => nameSpeaker(first.m.id, "S9", { name: "X" }, { root, voices }), /no voiceprint/);
});

test("saveSummary: notes next to the meeting, title in the list", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jarvis-meetings-"));
  const m = startMeeting({ bin: fakeHelper(), root });
  await new Promise((r) => setTimeout(r, 300));
  await stopMeeting();
  assert.equal(getMeeting(m.id, root).summary, null);
  saveSummary(m.id, { title: "Release check", summary: "Ready on Thursday.", decisions: [], actions: [{ owner: "You", task: "Send the notes" }], questions: [] }, root);
  const got = getMeeting(m.id, root);
  assert.equal(got.summary.title, "Release check");
  assert.equal(got.summary.actions[0].task, "Send the notes");
  assert.ok(got.summary.createdAt);
  assert.equal(listMeetings(root)[0].title, "Release check");
  assert.throws(() => saveSummary("../x", {}, root), /bad meeting id/);
});

test("retranscribeMeeting: new engine replaces the transcript, old one and its notes kept, names survive", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jarvis-meetings-"));
  const voices = path.join(root, "people.json");
  const model = path.join(root, "model.bin");
  writeFileSync(model, "x");
  const P = (i) => Array.from({ length: 256 }, (_, k) => (k === i ? 1 : 0));
  const { m } = await meetingWithVoices(root, voices, [P(1), P(2)], new Date(2026, 9, 25, 17, 56));
  for (const f of ["mic.wav", "system.wav"]) writeFileSync(path.join(m.dir, f), "RIFF");
  nameSpeaker(m.id, "S1", { name: "Pranshu" }, { root, voices });
  saveSummary(m.id, { title: "Old notes", summary: "From the English transcript.", decisions: [], actions: [], questions: [] }, root);

  // The redo hears the Hinglish line properly and the same two voices.
  const bin = fakeHelper({
    lines: [{ kind: "segment", stream: "mic", id: "m9", text: "Jab main thoda progress ho jaoonga to share kar loonga.", start: 435, end: 441, micDb: -25, systemDb: -120, micVoiced: 0.7, systemVoiced: 0 }],
    diarized: {
      turns: [{ speaker: "S1", start: 3.7, end: 10.9 }, { speaker: "S2", start: 15.8, end: 19.2 }],
      speakers: [
        { id: "S1", seconds: 7.2, turns: 1, print: P(1), voices: [{ id: "p-pranshu", score: 0.97 }], clip: "/x/S1.wav" },
        { id: "S2", seconds: 2.4, turns: 1, print: P(2), voices: [{ id: "p-pranshu", score: 0.1 }] },
      ],
    },
  });
  const events = [];
  const got = await retranscribeMeeting(m.id, { root, voices, model, bin, onEvent: (e) => events.push(e.state) });
  assert.equal(got.engine, "hybrid", "English + Hinglish is the redo default");
  assert.ok(got.retranscribedAt);
  assert.equal(got.title, undefined, "notes of the old transcript are no longer the meeting's title");
  assert.equal(got.summary, null);
  assert.ok(got.transcript.some((s) => /share kar loonga/.test(s.text)));
  assert.equal(got.speakers.find((s) => s.id === "S1").label, "Pranshu");
  assert.equal(got.speakers.find((s) => s.id === "S1").named, true, "you confirmed Pranshu; that holds");
  assert.ok(existsSync(path.join(m.dir, "transcript.parakeet.jsonl")));
  assert.equal(JSON.parse(readFileSync(path.join(m.dir, "summary.parakeet.json"), "utf8")).title, "Old notes");
  assert.ok(events.includes("diarizing"));
  assert.equal(readdirSync(m.dir).some((f) => f.startsWith(".redo-")), false, "scratch folder removed");
  assert.equal(JSON.parse(readFileSync(path.join(m.dir, "speakers.json"), "utf8"))[0].clip, "/x/S1.wav", "clip paths outside the scratch folder untouched");
  await assert.rejects(retranscribeMeeting("../x", { root }), /bad meeting id/);
});

test("startMeeting: missing helper is a clear error; stop with nothing running is not", async () => {
  assert.throws(() => startMeeting({ bin: "/nonexistent/parakeet" }), /build:parakeet/);
  assert.deepEqual(await stopMeeting(), { ok: false, reason: "no meeting running" });
  assert.throws(() => getMeeting("../etc"), /bad meeting id/);
});
