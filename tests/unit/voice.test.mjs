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

import { createConversation, followUpMs, isDismissal, isAck } from "../../apps/main/src/voice.js";
import { matchAppCommand } from "../../apps/main/src/shell.js";

test("nextVoiceAction: inside a conversation plain speech is a follow-up", () => {
  const on = { voiceMode: "on", wakeWord: "jarvis" };
  assert.deepEqual(nextVoiceAction("what's failing in the tests?", { ...on, inConversation: true }), { action: "follow-up", text: "what's failing in the tests?" });
  assert.deepEqual(nextVoiceAction("what's failing in the tests?", { ...on, inConversation: false }), { action: "ignored" });
  assert.deepEqual(nextVoiceAction("hey jarvis open a PR", { ...on, inConversation: true }), { action: "wake-task", text: "open a PR" });
  assert.deepEqual(nextVoiceAction("Thanks.", { ...on, inConversation: true }), { action: "ack" });
  assert.deepEqual(nextVoiceAction("Okay, that's all for now.", { ...on, inConversation: true }), { action: "dismiss" });
  assert.deepEqual(nextVoiceAction("hey jarvis, go to sleep", on), { action: "dismiss" });
  assert.deepEqual(nextVoiceAction("that's all", { ...on, inConversation: false }), { action: "ignored" }, "no window, no wake: not for Jarvis");
  assert.deepEqual(nextVoiceAction("run the tests", { voiceMode: "off", inConversation: true }), { action: "ignored" });
});

test("isDismissal / isAck: short phrases only", () => {
  for (const t of ["that's all", "Thanks Jarvis, that's all.", "goodbye", "stop listening", "we're done"]) assert.ok(isDismissal(t), t);
  for (const t of ["that's all the tests failing", "bye the way, check the build"]) assert.ok(!isDismissal(t), t);
  for (const t of ["ok", "Thanks!", "got it", "sounds good", "hmm"]) assert.ok(isAck(t), t);
  assert.ok(!isAck("ok run the tests"));
});

test("conversation window: opens on wake, held while Jarvis works, expires after follow-up", () => {
  let t = 0;
  const c = createConversation({ now: () => t });
  assert.equal(c.isOpen(), false);
  assert.equal(c.open(0), false, "follow-up off never opens");
  assert.equal(c.open(30000), true);
  t = 20000; assert.equal(c.isOpen(), true);
  c.hold("turn"); c.hold("speaking");
  t = 120000; assert.equal(c.isOpen(), true, "held while thinking/speaking");
  c.release("turn", 30000);
  t = 200000; assert.equal(c.isOpen(), true, "still speaking");
  c.release("speaking", 30000); // countdown restarts when Jarvis stops talking
  c.release("speaking", 30000); // double release is harmless
  t = 229000; assert.equal(c.isOpen(), true);
  t = 230001; assert.equal(c.isOpen(), false);
  c.touch(30000); assert.equal(c.isOpen(), false, "touch never reopens a closed window");
  c.open(15000); c.close(); assert.equal(c.isOpen(), false);
});

test("followUpMs + follow-up phrases", () => {
  assert.equal(followUpMs("30"), 30000);
  assert.equal(followUpMs("off"), 0);
  assert.deepEqual(matchAppCommand("turn conversation mode off"), { name: "set.followUp", args: { value: "off" } });
  assert.deepEqual(matchAppCommand("keep listening for 2 minutes"), { name: "set.followUp", args: { value: "120" } });
  assert.deepEqual(matchAppCommand("set follow up to 60 seconds"), { name: "set.followUp", args: { value: "60" } });
  assert.equal(matchAppCommand("keep listening for 7 seconds"), null);
});
