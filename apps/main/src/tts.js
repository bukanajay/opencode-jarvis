// Jarvis's speaking voice. One persistent jarvis-voice helper (Kokoro-82M, on
// device) keeps the model warm and turns each spoken line into a WAV; the deck
// plays the bytes. One voice, fixed by the shell `voice` setting, so it never
// changes between turns. Without the helper (Intel) the deck falls back to the
// system voice, pinned by name.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const VOICE_BIN = path.join(here, "../../audio-voice/bin/jarvis-voice");

let child = null;
let childVoice = null;
let ready = null;
let buf = "";
const waiting = new Map(); // id -> { resolve, reject, timer }

export function hasNeuralVoice(bin = VOICE_BIN) {
  return existsSync(bin);
}

function settleAll(err) {
  for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(err); }
  waiting.clear();
}

export function stopVoice() {
  if (child) { try { child.kill("SIGKILL"); } catch {} }
  child = null;
  childVoice = null;
  ready = null;
  settleAll(new Error("voice stopped"));
}

function start(voice, bin) {
  stopVoice();
  const proc = spawn(bin, ["--voice", voice], { stdio: ["pipe", "pipe", "ignore"] });
  child = proc;
  childVoice = voice;
  buf = "";
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("voice warm-up timeout")), 300000);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === "status" && msg.state === "ready") { clearTimeout(timer); resolve(); }
        else if (msg.kind === "status") { clearTimeout(timer); reject(new Error(`voice:${msg.state} ${msg.note ?? ""}`)); }
        const w = waiting.get(msg.id);
        if (!w) continue;
        waiting.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.kind === "audio") w.resolve({ path: msg.path, ms: msg.ms });
        else w.reject(new Error(`voice: ${msg.note ?? "synthesis failed"}`));
      }
    });
  });
  ready.catch(() => {});
  proc.on("close", () => {
    if (child === proc) { child = null; childVoice = null; ready = null; settleAll(new Error("voice helper exited")); }
  });
}

// Warm the helper ahead of the first reply (voice mode on, app start).
export function warmVoice(voice, bin = VOICE_BIN) {
  if (!hasNeuralVoice(bin)) return null;
  if (!child || childVoice !== voice) start(voice, bin);
  return ready;
}

let seq = 0;
// Resolves { audio: Buffer (WAV), ms } or null when no neural voice exists.
export async function synthesize(text, voice, { bin = VOICE_BIN, timeoutMs = 30000 } = {}) {
  if (!hasNeuralVoice(bin)) return null;
  await warmVoice(voice, bin);
  const id = `s${Date.now().toString(36)}${(seq++).toString(36)}`;
  const out = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("voice timeout")); }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, text })}\n`);
  });
  const audio = readFileSync(out.path);
  rmSync(out.path, { force: true });
  return { audio, ms: out.ms };
}
