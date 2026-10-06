import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpeak, spokenSummary, speechFor, stripSpeak, voiceGate, isHush } from "../../apps/main/src/speech.js";
import { buildThinkPrompt, stripDispatches, fencedFilter, parseDispatches, VOICE_ADDENDUM } from "../../apps/main/src/brain/brain.js";
import { buildReport, buildReviewPrompt } from "../../apps/main/src/brain/report.js";

const sp = (text) => "```speak " + JSON.stringify({ text }) + "```";

test("parseSpeak: exact shape only", () => {
  assert.equal(parseSpeak(`Long answer…\n${sp("The parser is fixed and tests pass.")}`), "The parser is fixed and tests pass.");
  assert.equal(parseSpeak('```speak {"text":"x","voice":"y"}```'), null);
  assert.equal(parseSpeak("```speak {nope}```"), null);
  assert.equal(parseSpeak("no fence"), null);
});

test("spokenSummary: first sentences, nothing that reads badly aloud", () => {
  const reply = "The bug is in `parseFences` in apps/main/src/brain/brain.js. It drops **extra** keys. Then a third sentence that is not spoken.\n```js\nconst x = 1;\n```";
  const s = spokenSummary(reply);
  assert.equal(s, "The bug is in parseFences in a file. It drops extra keys.");
  assert.equal(spokenSummary("[fleet] default->build → build (abc12345)\nOn it."), "On it.");
  assert.equal(spokenSummary("See https://example.com/x for details."), "See a link for details.");
  assert.equal(spokenSummary(""), "");
});

test("spokenSummary: long text is clipped at a word boundary", () => {
  const s = spokenSummary("word ".repeat(200), 60);
  assert.ok(s.length <= 61);
  assert.ok(s.endsWith("…"));
  assert.doesNotMatch(s, /wor…$/);
});

test("speechFor: model line wins, summary is the fallback", () => {
  assert.equal(speechFor(`Details.\n${sp("Short version.")}`), "Short version.");
  assert.equal(speechFor("Done. All green."), "Done. All green.");
});

test("speak fences never reach the transcript or the stream", () => {
  assert.equal(stripDispatches(`Answer.\n${sp("Spoken.")}`), "Answer.");
  assert.equal(stripSpeak(`a\n${sp("b")}`), "a");
  const seen = [];
  const f = fencedFilter((d) => seen.push(d));
  f.push(`Answer.\n${sp("Spoken.")}\n`);
  f.flush();
  assert.deepEqual(seen, ["Answer.\n"]);
  assert.deepEqual(parseDispatches(sp("x")).dispatches, [], "speak is not a dispatch");
});

test("voice prompts ask for a speak line only in voice mode", () => {
  assert.doesNotMatch(buildThinkPrompt("hi", [], []), /```speak/);
  assert.match(buildThinkPrompt("hi", [], [], null, { voice: true }), /```speak/);
  assert.match(VOICE_ADDENDUM, /under 40 words/);
  const review = buildReviewPrompt(buildReport({ sessionID: "ses_1", task: "t" }, {}));
  assert.doesNotMatch(review, /```speak/, "review prompt adds it only when brainReview runs in voice mode");
});

test("voiceGate: Jarvis's own voice is dropped, explicit wake barges in", () => {
  assert.equal(voiceGate("anything", { speaking: false }), "pass");
  assert.equal(voiceGate("the tests pass now", { speaking: true }), "drop");
  assert.equal(voiceGate("Jarvis here, the tests pass", { speaking: true }), "drop", "bare wake in its own speech");
  assert.equal(voiceGate("hey jarvis stop", { speaking: true }), "barge");
  assert.equal(voiceGate("OK Friday, what next", { speaking: true, wakeWord: "friday" }), "barge");
  assert.equal(voiceGate("hey jarvis", { speaking: true }), "barge");
});

test("isHush", () => {
  for (const t of ["stop", "Quiet.", "shut up", "never mind", "nevermind"]) assert.equal(isHush(t), true, t);
  assert.equal(isHush("stop the worker"), false);
});
