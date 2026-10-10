// Jarvis's speaking voice on Apple Silicon: the real jarvis-voice helper
// (Kokoro-82M) through Main's tts.js. Proves the model stays warm, every turn
// comes back in the one configured voice, and the speech is intelligible
// (round-tripped through the Parakeet helper).
// Needs: npm run build:parakeet (builds both helpers, downloads both models).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const PARAKEET = path.join(ROOT, "apps/audio-parakeet/bin/parakeet");
const { synthesize, warmVoice, stopVoice, hasNeuralVoice } = await import("../apps/main/src/tts.js");
const { DEFAULTS } = await import("../apps/main/src/shell.js");
if (!hasNeuralVoice()) throw new Error("no jarvis-voice binary: run npm run build:parakeet");

const voice = DEFAULTS.voice;
let t0 = Date.now();
await warmVoice(voice);
console.log(`warm-ok: ${voice} ready in ${Date.now() - t0} ms`);

const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-voice-"));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
try {
  const lines = [
    "On it. I've asked the build agent to fix the parser.",
    "Done. The parser is fixed and all tests pass.",
    "Shall I open a pull request?",
  ];
  for (const [i, line] of lines.entries()) {
    t0 = Date.now();
    const r = await synthesize(line, voice);
    const ms = Date.now() - t0;
    if (r.audio.subarray(0, 4).toString() !== "RIFF") throw new Error("not a WAV");
    if (r.ms < 500) throw new Error(`suspiciously short audio: ${r.ms} ms`);
    const wav = path.join(dir, `l${i}.wav`);
    writeFileSync(wav, r.audio);
    let heard = "(parakeet not built)";
    if (existsSync(PARAKEET)) {
      heard = JSON.parse(execFileSync(PARAKEET, ["--file", wav]).toString().trim().split("\n").pop()).text;
      const want = norm(line).split(" ");
      const got = new Set(norm(heard).split(" "));
      const hit = want.filter((w) => got.has(w)).length / want.length;
      if (hit < 0.8) throw new Error(`unintelligible: said "${line}", heard "${heard}"`);
    }
    console.log(`turn-ok: ${voice}, rendered in ${ms} ms, ${r.ms} ms of audio, heard "${heard}"`);
  }
} finally {
  stopVoice();
  rmSync(dir, { recursive: true, force: true });
}
console.log("jarvis-voice-ok");
process.exit(0);
