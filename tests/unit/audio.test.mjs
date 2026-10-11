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
