import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultEngine, resolveEngine, toUtterance } from "../../apps/main/src/audio.js";

test("defaultEngine: parakeet only on Apple Silicon with the live binary built", () => {
  assert.equal(defaultEngine({ platform: "darwin", arch: "arm64", hasParakeet: true }), "parakeet");
  assert.equal(defaultEngine({ platform: "darwin", arch: "arm64", hasParakeet: false }), "speech-analyzer");
  assert.equal(defaultEngine({ platform: "darwin", arch: "x64", hasParakeet: true }), "speech-analyzer");
  assert.equal(defaultEngine({ platform: "linux", arch: "arm64", hasParakeet: true }), "speech-analyzer");
});

test("resolveEngine: explicit name wins, unknown names are rejected", () => {
  assert.equal(resolveEngine("parakeet").label, "parakeet-v3");
  assert.equal(resolveEngine("speech-analyzer").label, "speech-analyzer");
  assert.throws(() => resolveEngine("bogus"), /unknown audio engine/);
});

test("toUtterance: engine label carried, source is speech", () => {
  const u = toUtterance({ id: "a", text: "hi", engine: "parakeet-v3" });
  assert.equal(u.source, "speech");
  assert.equal(u.engine, "parakeet-v3");
});

test("languageArgs: English stays on Parakeet; Hindi -> Apex, Marathi -> multilingual Whisper; missing model is a clear error", async () => {
  const { languageArgs } = await import("../../apps/main/src/audio.js");
  const yes = () => true;
  assert.deepEqual(languageArgs("en", { exists: yes }), []);
  assert.deepEqual(languageArgs("hi", { modelsDir: "/m", exists: yes }), ["--engine", "whisper", "--model", "/m/ggml-apex-hinglish-q8_0.bin", "--language", "hi"]);
  assert.deepEqual(languageArgs("mr", { modelsDir: "/m", exists: yes }), ["--engine", "whisper", "--model", "/m/ggml-large-v3-turbo-q8_0.bin", "--language", "mr"]);
  assert.throws(() => languageArgs("mr", { exists: () => false }), /Marathi needs a speech model: npm run fetch:whisper-model -- multilingual/);
});

test("listenLanguage setting: en | hi | mr", async () => {
  const { validateAppCommand } = await import("../../apps/main/src/shell.js");
  for (const v of ["en", "hi", "mr"]) assert.doesNotThrow(() => validateAppCommand("set.listenLanguage", { value: v }));
  assert.throws(() => validateAppCommand("set.listenLanguage", { value: "ta" }), /en\|hi\|mr/);
});
