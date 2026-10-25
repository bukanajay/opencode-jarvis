import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createMeetingLog, echoVerdict, getMeeting, isMeetingActive, listMeetings, meetingId, speakerFor,
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
function fakeHelper() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-fake-parakeet-"));
  const bin = path.join(dir, "parakeet");
  const lines = [
    { kind: "status", state: "listening", note: "fake", route: "speakers" },
    { kind: "partial", stream: "mic", id: "m1", text: "Good evening", revision: 1 },
    { kind: "segment", stream: "mic", id: "m1", text: GOOD_EVENING, start: 3.9, end: 10.7, micDb: -23, systemDb: -14, micVoiced: 0.85, systemVoiced: 0.84 },
    { kind: "segment", stream: "system", id: "s1", text: GOOD_EVENING, start: 3.8, end: 10.8, micDb: -23, systemDb: -14, micVoiced: 0.85, systemVoiced: 0.84 },
    { kind: "segment", stream: "mic", id: "m2", text: "Great, I will review it after lunch.", start: 12.3, end: 15.4, micDb: -30, systemDb: -120, micVoiced: 0.5, systemVoiced: 0 },
  ];
  writeFileSync(bin, `#!/usr/bin/env node
const lines = ${JSON.stringify(lines)};
const dir = process.argv[process.argv.indexOf("--meeting") + 1];
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

test("startMeeting: missing helper is a clear error; stop with nothing running is not", async () => {
  assert.throws(() => startMeeting({ bin: "/nonexistent/parakeet" }), /build:parakeet/);
  assert.deepEqual(await stopMeeting(), { ok: false, reason: "no meeting running" });
  assert.throws(() => getMeeting("../etc"), /bad meeting id/);
});
