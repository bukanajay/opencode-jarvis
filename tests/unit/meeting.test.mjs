import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assignSpeakers, createMeetingLog, echoVerdict, getMeeting, isMeetingActive, listMeetings, meetingId, speakerFor,
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

test("startMeeting: missing helper is a clear error; stop with nothing running is not", async () => {
  assert.throws(() => startMeeting({ bin: "/nonexistent/parakeet" }), /build:parakeet/);
  assert.deepEqual(await stopMeeting(), { ok: false, reason: "no meeting running" });
  assert.throws(() => getMeeting("../etc"), /bad meeting id/);
});
