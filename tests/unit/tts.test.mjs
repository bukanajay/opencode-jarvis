import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesize, warmVoice, stopVoice, hasNeuralVoice } from "../../apps/main/src/tts.js";
import { matchAppCommand, applyAppCommand, loadStore, VOICES, DEFAULTS } from "../../apps/main/src/shell.js";

// A stand-in jarvis-voice: same stdout protocol, records which voice it was started with.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tts-"));
const bin = path.join(dir, "fake-voice");
fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); const path = require("path"); const rl = require("readline");
const voice = process.argv[process.argv.indexOf("--voice") + 1];
console.log(JSON.stringify({ kind: "status", state: "ready", voice }));
rl.createInterface({ input: process.stdin }).on("line", (l) => {
  const { id, text } = JSON.parse(l);
  if (text === "fail") return console.log(JSON.stringify({ kind: "error", id, note: "boom" }));
  const p = path.join(${JSON.stringify(dir)}, id + ".wav");
  fs.writeFileSync(p, "RIFF" + voice + ":" + text);
  console.log(JSON.stringify({ kind: "audio", id, path: p, ms: 1234 }));
});
`);
fs.chmodSync(bin, 0o755);
after(() => { stopVoice(); fs.rmSync(dir, { recursive: true, force: true }); });

test("synthesize: every line in the one configured voice, in order", async () => {
  const a = await synthesize("hello there", "bm_george", { bin });
  const b = await synthesize("all tests pass", "bm_george", { bin });
  assert.equal(a.audio.toString(), "RIFFbm_george:hello there");
  assert.equal(b.audio.toString(), "RIFFbm_george:all tests pass");
  assert.equal(a.ms, 1234);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".wav")).length, 0, "temp wavs cleaned up");
});

test("synthesize: a voice change restarts the helper in the new voice", async () => {
  const r = await synthesize("hi", "bm_fable", { bin });
  assert.equal(r.audio.toString(), "RIFFbm_fable:hi");
});

test("synthesize: helper errors reject, no neural voice resolves null", async () => {
  await assert.rejects(synthesize("fail", "bm_fable", { bin }), /boom/);
  assert.equal(hasNeuralVoice(path.join(dir, "missing")), false);
  assert.equal(await synthesize("hi", "bm_george", { bin: path.join(dir, "missing") }), null);
  assert.equal(warmVoice("bm_george", path.join(dir, "missing")), null);
});

test("voice setting: default, validation, spoken phrases", () => {
  assert.equal(DEFAULTS.voice, "bm_george");
  assert.ok(VOICES.includes("bm_george"));
  assert.deepEqual(matchAppCommand("use the fable voice"), { name: "set.voice", args: { value: "bm_fable" } });
  assert.deepEqual(matchAppCommand("set voice to am_michael"), { name: "set.voice", args: { value: "am_michael" } });
  assert.deepEqual(matchAppCommand("Set the voice to Lewis"), { name: "set.voice", args: { value: "bm_lewis" } });
  assert.equal(matchAppCommand("use the robot voice"), null);
  const store = loadStore();
  assert.throws(() => applyAppCommand(store, "set.voice", { value: "robot" }), /unknown voice/);
  applyAppCommand(store, "set.voice", { value: "bm_lewis" });
  assert.equal(loadStore().settings.voice, "bm_lewis", "persists across reloads");
});

import { validateAppCommand } from "../../apps/main/src/shell.js";
import { buildThinkPrompt } from "../../apps/main/src/brain/brain.js";

test("onboarding settings: name + onboarded flag", () => {
  assert.equal(DEFAULTS.onboarded, "off", "first launch shows the setup wizard");
  assert.equal(DEFAULTS.userName, "");
  validateAppCommand("set.userName", { value: "Ajay" });
  validateAppCommand("set.userName", { value: "Anne-Marie O'Neil" });
  validateAppCommand("set.userName", { value: "José" });
  assert.throws(() => validateAppCommand("set.userName", { value: "<script>" }), /letters/);
  assert.throws(() => validateAppCommand("set.userName", { value: "x".repeat(60) }), /max 48/);
  assert.throws(() => validateAppCommand("set.onboarded", { value: "maybe" }), /on\|off/);
  assert.deepEqual(matchAppCommand("call me Ajay"), { name: "set.userName", args: { value: "Ajay" } });
  assert.deepEqual(matchAppCommand("My name is Ajay."), { name: "set.userName", args: { value: "Ajay" } });
});

test("brain prompt carries the user's name only when known", () => {
  assert.match(buildThinkPrompt("hi", [], [], null, { userName: "Ajay" }), /The user's name is Ajay/);
  assert.doesNotMatch(buildThinkPrompt("hi", [], [], null, {}), /user's name/);
});
