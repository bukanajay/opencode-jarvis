import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  forgetVoice, hasMyVoice, listVoices, loadVoices, micVoice, recordEnrollment, setMyVoice,
} from "../../apps/main/src/voices.js";
import { createMeetingLog, SOMEONE_ELSE } from "../../apps/main/src/meeting.js";

const vec = (i) => Array.from({ length: 256 }, (_, k) => (k === i ? 1 : 0.01));
const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-voices-")), "voices", "people.json");

test("setMyVoice: stores your print readable only by you; list hides vectors; forget deletes", () => {
  const file = tmpFile();
  assert.equal(hasMyVoice(file), false);
  const r = setMyVoice({ embeddings: [vec(0), vec(0), vec(1)], name: "Ajay" }, file, new Date("2026-10-25T10:00:00Z"));
  assert.deepEqual(r, { id: "me", samples: 3 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  const me = loadVoices(file).people[0];
  assert.equal(me.mean.length, 256);
  assert.ok(Math.abs(Math.hypot(...me.mean) - 1) < 1e-9, "mean is unit length");
  const listed = listVoices(file);
  assert.deepEqual(listed.map((p) => [p.id, p.name, p.isMe, p.samples]), [["me", "Ajay", true, 3]]);
  assert.equal(JSON.stringify(listed).includes("mean"), false, "no vectors leave Main");

  // Re-enrolling replaces the print but keeps when you first enrolled.
  setMyVoice({ embeddings: [vec(2)] }, file, new Date("2026-11-01T10:00:00Z"));
  const again = loadVoices(file).people;
  assert.equal(again.length, 1);
  assert.equal(again[0].createdAt, "2026-10-25T10:00:00.000Z");
  assert.equal(again[0].embeddings.length, 1);

  assert.deepEqual(forgetVoice("me", file), { ok: true });
  assert.equal(hasMyVoice(file), false);
  assert.equal(readFileSync(file, "utf8").includes("embeddings"), false, "vectors are gone from disk");
  assert.equal(forgetVoice("me", file).ok, false);
  assert.throws(() => setMyVoice({ embeddings: [[1, 2, 3]] }, file), /256-dim/);
});

test("micVoice: thresholds from the real call (you 0.81–0.96, others ≤0.17)", () => {
  assert.equal(micVoice({ voices: [{ id: "me", score: 0.81 }] }), "me");
  assert.equal(micVoice({ voices: [{ id: "me", score: 0.17 }] }), "other");
  assert.equal(micVoice({ voices: [{ id: "me", score: 0.42 }] }), null, "in between: let the other rules decide");
  assert.equal(micVoice({}), null, "too short to print");
  assert.equal(micVoice({ voices: [] }), null, "no profile");
});

const seg = (o) => ({ id: Math.random().toString(36).slice(2), micDb: -30, systemDb: -120, micVoiced: 0.6, systemVoiced: 0, ...o });

test("meeting log: your voice is never hidden, even when you repeat what they said", () => {
  const log = createMeetingLog({ route: "speakers" });
  log.add(seg({ stream: "system", text: "Can you send the release notes today?", start: 1, end: 3 }));
  const [mine] = log.add(seg({ stream: "mic", text: "Can you send the release notes today?", start: 1.2, end: 3.1, voices: [{ id: "me", score: 0.9 }] }));
  assert.equal(mine.echo, null);
  assert.equal(mine.speaker, "You");
});

test("meeting log: not your voice while the call plays is echo; with no call audio, someone else", () => {
  const log = createMeetingLog({ route: "speakers" });
  const [echo] = log.add(seg({ stream: "mic", text: "Okay. Which will be implemented through the code.", start: 398.4, end: 402, systemVoiced: 0.69, voices: [{ id: "me", score: 0.17 }] }));
  assert.equal(echo.echo, "voice", "the words differed from the call's copy, the voice did not");
  const [other] = log.add(seg({ stream: "mic", text: "Can I borrow your charger?", start: 500, end: 502, voices: [{ id: "me", score: 0.1 }] }));
  assert.equal(other.echo, null);
  assert.equal(other.speaker, SOMEONE_ELSE);
  // A call segment arriving later still turns an unclaimed mic line into echo.
  const [late] = log.add(seg({ stream: "mic", text: "uh huh", start: 600, end: 602.5, voices: [{ id: "me", score: 0.12 }] }));
  assert.equal(late.speaker, SOMEONE_ELSE);
  const changed = log.add(seg({ stream: "system", text: "Something else entirely", start: 599.8, end: 603 }));
  assert.deepEqual(changed.map((s) => s.id), [changed[0].id, late.id]);
  assert.equal(late.echo, "voice");
  assert.deepEqual(log.transcript().map((s) => s.speaker), [SOMEONE_ELSE, "Them"]);
});

function fakeEnroller(result) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-fake-enroll-"));
  const bin = path.join(dir, "parakeet");
  writeFileSync(bin, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ kind: "status", state: "listening", note: "fake" }));
console.log(JSON.stringify({ kind: "level", db: -24.5, seconds: 0.1 }));
process.stdin.on("data", (d) => {
  if (!String(d).includes("stop")) return;
  console.log(JSON.stringify(${JSON.stringify(result)}));
  process.exit(0);
});
`);
  chmodSync(bin, 0o755);
  return { bin, args: () => JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8")) };
}

test("recordEnrollment: meter levels, stop, result with embeddings; test mode and refusals", async () => {
  const file = tmpFile();
  setMyVoice({ embeddings: [vec(0)] }, file);
  const good = { kind: "enrollment", seconds: 31, voiced: 24, windows: 6, consistency: { min: 0.7, mean: 0.8 }, embeddings: [vec(0), vec(0)], mean: vec(0) };
  const f = fakeEnroller(good);
  const levels = [];
  const run = recordEnrollment({ bin: f.bin, file, onLevel: (l) => levels.push(l) });
  assert.throws(() => recordEnrollment({ bin: f.bin, file }), /already recording/);
  await new Promise((r) => setTimeout(r, 300));
  run.stop();
  const r = await run.done;
  assert.equal(r.ok, true);
  assert.equal(r.embeddings.length, 2);
  assert.deepEqual(levels, [{ db: -24.5, seconds: 0.1 }]);
  assert.deepEqual(f.args(), ["--enroll", "--seconds", "30", "--voices", file]);

  const t = fakeEnroller({ kind: "enrollment", seconds: 8, voiced: 6, windows: 1, meScore: 0.88 });
  const run2 = recordEnrollment({ bin: t.bin, file, test: true, seconds: 10 });
  await new Promise((r2) => setTimeout(r2, 300));
  run2.stop();
  const r2 = await run2.done;
  assert.equal(r2.meScore, 0.88);
  assert.ok(t.args().includes("--test"));

  const quiet = fakeEnroller({ kind: "enrollment", seconds: 30, voiced: 4, windows: 1, error: "too little speech: 4 s heard, need 10 s" });
  const run3 = recordEnrollment({ bin: quiet.bin, file });
  await new Promise((r3) => setTimeout(r3, 300));
  run3.stop();
  const r3 = await run3.done;
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /too little speech/);
  assert.throws(() => recordEnrollment({ bin: "/nonexistent/parakeet", file }), /build:parakeet/);
});

test("rememberVoice: a name builds one person; samples capped; your own voice refused", async () => {
  const { rememberVoice, renameVoice, mergeVoices, bestVoice } = await import("../../apps/main/src/voices.js");
  const file = tmpFile();
  setMyVoice({ embeddings: [vec(0)] }, file);
  const a = rememberVoice({ name: "  Ravi  Kumar ", embedding: vec(3), source: "meeting:m1" }, file);
  assert.deepEqual(a, { id: "p-ravi-kumar", name: "Ravi Kumar", samples: 1 });
  const b = rememberVoice({ name: "ravi kumar", embedding: vec(3), source: "meeting:m2" }, file);
  assert.equal(b.id, "p-ravi-kumar", "same name, same person");
  assert.equal(b.samples, 2);
  const p = loadVoices(file).people.find((x) => x.id === "p-ravi-kumar");
  assert.deepEqual(p.sources, ["meeting:m1", "meeting:m2"]);
  for (let i = 0; i < 60; i++) rememberVoice({ personId: "p-ravi-kumar", embedding: vec(3) }, file);
  assert.equal(loadVoices(file).people.find((x) => x.id === "p-ravi-kumar").embeddings.length, 50);
  assert.throws(() => rememberVoice({ personId: "me", embedding: vec(0) }, file), /your own voice/);
  assert.throws(() => rememberVoice({ name: "", embedding: vec(0) }, file), /name is required/);

  assert.equal(bestVoice(vec(3), loadVoices(file).people).id, "p-ravi-kumar");
  assert.equal(bestVoice(vec(0), loadVoices(file).people).id, "p-ravi-kumar", "never you, even when it is your voice");

  const dup = rememberVoice({ name: "R. Kumar", embedding: vec(4) }, file);
  assert.deepEqual(mergeVoices(dup.id, "p-ravi-kumar", file), { ok: true, id: "p-ravi-kumar", samples: 50 });
  assert.equal(loadVoices(file).people.some((x) => x.id === dup.id), false);
  assert.equal(mergeVoices("me", "p-ravi-kumar", file).ok, false);
  assert.deepEqual(renameVoice("p-ravi-kumar", "Ravi", file), { ok: true, id: "p-ravi-kumar", name: "Ravi" });
  assert.equal(renameVoice("p-ravi-kumar", "  ", file).ok, false);
});
