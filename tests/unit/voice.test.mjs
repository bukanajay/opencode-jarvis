import { test } from "node:test";
import assert from "node:assert/strict";
import { hasWake, stripWake, nextVoiceAction } from "../../apps/main/src/voice.js";

test("hasWake: whole-word, case-insensitive", () => {
  assert.equal(hasWake("Hey Jarvis, run it", "jarvis"), true);
  assert.equal(hasWake("jarvisville", "jarvis"), false);
  assert.equal(hasWake("anything", ""), false);
});

test("stripWake: removes one leading prefix and punctuation", () => {
  assert.equal(stripWake("hey jarvis, dim the fleet", "jarvis"), "dim the fleet");
  assert.equal(stripWake("OK Jarvis: status", "jarvis"), "status");
  assert.equal(stripWake("jarvis", "jarvis"), "");
});

test("nextVoiceAction: gated by voice mode and wake word", () => {
  assert.deepEqual(nextVoiceAction("hey jarvis run tests", { voiceMode: "off" }), { action: "ignored" });
  assert.deepEqual(nextVoiceAction("run tests", { voiceMode: "on" }), { action: "ignored" });
  assert.deepEqual(nextVoiceAction("hey jarvis", { voiceMode: "on" }), { action: "wake-empty" });
  assert.deepEqual(nextVoiceAction("hey friday run tests", { voiceMode: "on", wakeWord: "friday" }), { action: "wake-task", text: "run tests" });
});
