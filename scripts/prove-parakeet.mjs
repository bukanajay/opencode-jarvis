// Parakeet live engine on Apple Silicon: real model, real speech, Main's own path.
// macOS `say` renders spoken commands to audio; the helper streams them through
// its live pipeline (16 kHz resample, VAD, rolling partials, silence commit)
// via --replay, and the final goes through listenOnce -> toUtterance -> voice
// gate -> fleet routing exactly like a microphone utterance would.
// Needs: npm run build:parakeet (builds bin/parakeet and downloads the model).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const BIN = path.join(ROOT, "apps/audio-parakeet/bin/parakeet");
if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("skip: parakeet live engine is Apple Silicon only");
  process.exit(0);
}
if (!existsSync(BIN)) throw new Error("no live binary: run npm run build:parakeet");

const { listenOnce, toUtterance, defaultEngine } = await import("../apps/main/src/audio.js");
const { nextVoiceAction } = await import("../apps/main/src/voice.js");
const { routeUtterance } = await import("../apps/main/src/fleet.js");

if (defaultEngine() !== "parakeet") throw new Error("parakeet is not the default engine on this Mac");
console.log("engine-ok: parakeet is the default on Apple Silicon");

const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-parakeet-"));
const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
try {
  const cases = [
    { say: "Hey Jarvis, use the amber accent.", expect: "hey jarvis use the amber accent", route: "set.accent" },
    { say: "Hey Jarvis, ask the build agent to fix the failing parser tests.", expect: "hey jarvis ask the build agent to fix the failing parser tests" },
  ];
  for (const [i, c] of cases.entries()) {
    const file = path.join(dir, `c${i}.aiff`);
    execFileSync("say", ["-o", file, c.say]);

    const t0 = Date.now();
    const out = JSON.parse(execFileSync(BIN, ["--file", file]).toString().trim().split("\n").pop());
    if (norm(out.text) !== c.expect) throw new Error(`file: heard "${out.text}"`);
    console.log(`file-ok: "${out.text}" in ${Date.now() - t0} ms (model load + transcribe)`);

    const partials = [];
    const fin = await listenOnce({ engine: "parakeet", replay: file, timeoutMs: 60000, onPartial: (p) => partials.push(p) });
    if (norm(fin.text) !== c.expect) throw new Error(`live: heard "${fin.text}"`);
    if (partials.length < 1) throw new Error("live: no partial captions");
    if (partials.some((p, k) => k > 0 && p.revision <= partials[k - 1].revision)) throw new Error("live: revisions not increasing");
    const u = toUtterance(fin);
    if (u.source !== "speech" || u.engine !== "parakeet-v3") throw new Error("utterance shape drift");
    console.log(`live-ok: ${partials.length} partials -> final "${fin.text}"`);

    const next = nextVoiceAction(u.text, { voiceMode: "on", wakeWord: "jarvis" });
    if (next.action !== "wake-task") throw new Error(`wake gate: ${next.action}`);
    if (c.route) {
      const r = routeUtterance(next.text, false);
      if (r.name !== c.route) throw new Error(`routed "${next.text}" to ${r.route}/${r.name}`);
      console.log(`route-ok: "${next.text}" -> ${r.name}`);
    } else {
      console.log(`wake-ok: "${next.text}" dispatched hands-free`);
    }
  }

  // Silence must not commit anything: the helper keeps listening until timeout.
  const quiet = path.join(dir, "quiet.aiff");
  execFileSync("say", ["-o", quiet, "[[slnc 1500]]"]);
  try {
    await listenOnce({ engine: "parakeet", replay: quiet, timeoutMs: 15000 });
    throw new Error("silence produced a final");
  } catch (e) {
    if (!/replay ended without a final/.test(e.message)) throw e;
  }
  console.log("silence-ok: no utterance from silence");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("parakeet-ok");
process.exit(0);
