import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let mod;
before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-unit-mem-"));
  process.env.JARVIS_MEMORY_FILE = path.join(dir, "memory.json");
  process.env.JARVIS_EMBED_OFF = "1";
  mod = await import("../../apps/main/src/brain/memory.js");
});

test("remember / loadMemory round-trip and dedupe", () => {
  const mem = mod.loadMemory();
  assert.ok(mod.remember(mem, "user prefers amber accent"));
  assert.equal(mod.remember(mem, "User prefers AMBER accent"), null);
  assert.equal(mod.loadMemory().facts.length, 1);
});

test("forget removes a fact", () => {
  const mem = mod.loadMemory();
  const f = mod.remember(mem, "temporary fact");
  assert.equal(mod.forget(mem, f.id), true);
  assert.equal(mod.forget(mem, f.id), false);
});

test("bm25Recall ranks overlap and ignores stopwords", () => {
  const mem = mod.loadMemory();
  mod.remember(mem, "tests run with pnpm vitest");
  const hits = mod.bm25Recall(mem, "how do the tests run?");
  assert.match(hits[0].text, /vitest/);
  assert.deepEqual(mod.bm25Recall(mem, "the a is"), []);
});

test("recall falls back to BM25 when embeddings are off", async () => {
  const hits = await mod.recall(mod.loadMemory(), "which accent");
  assert.ok(hits.some((f) => /amber/.test(f.text)));
});

test("extractCandidates: heuristic facts", () => {
  assert.deepEqual(mod.extractCandidates("remember that deploys go through staging"), ["deploys go through staging"]);
  assert.deepEqual(mod.extractCandidates("my editor is vim"), ["user's editor is vim"]);
  assert.deepEqual(mod.extractCandidates("I prefer tabs"), ["user prefers tabs"]);
  assert.deepEqual(mod.extractCandidates("hello"), []);
});
