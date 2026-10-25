// Known voices (docs/MEETING-MODE.md, Phase 2): your voiceprint now, the
// people you name after meetings later. One file, readable only by you,
// never sent anywhere and never put in the brain's context:
// ~/.config/jarvis/voices/people.json
//   { version: 1, people: [{ id, name, isMe, mean: [256], embeddings: [[256]…],
//     createdAt, updatedAt, sources: ["enroll" | "meeting:<id>"] }] }
// The parakeet helper reads `id` and `mean` (src/voice.swift).
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PARAKEET_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../audio-parakeet/bin/parakeet");

export const ME = "me";
// Cosine similarity of a segment's voiceprint to a profile. Measured on a
// real call: your own held-out lines 0.81–0.96, the other side and speaker
// echo of them 0.07–0.16.
export const SAME_VOICE = 0.5;
export const OTHER_VOICE = 0.35;
const MAX_EMBEDDINGS = 50;

export function voicesFile(env = process.env) {
  return env.JARVIS_VOICES_FILE ?? path.join(os.homedir(), ".config", "jarvis", "voices", "people.json");
}

export function loadVoices(file = voicesFile()) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v.people) ? v : { version: 1, people: [] };
  } catch {
    return { version: 1, people: [] };
  }
}

function saveVoices(v, file = voicesFile()) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

const norm = (v) => {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
};
const meanOf = (vs) => norm(vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0)));

// What the deck may see: no vectors.
export function listVoices(file = voicesFile()) {
  return loadVoices(file).people.map(({ id, name, isMe, embeddings, createdAt, updatedAt, sources }) => ({
    id, name, isMe: !!isMe, samples: embeddings?.length ?? 0, createdAt, updatedAt, sources: sources ?? [],
  }));
}

export const hasMyVoice = (file = voicesFile()) => loadVoices(file).people.some((p) => p.id === ME);

// Replace your voiceprint with a fresh enrollment.
export function setMyVoice({ embeddings, name = "You" }, file = voicesFile(), now = new Date()) {
  if (!Array.isArray(embeddings) || !embeddings.length || embeddings.some((e) => !Array.isArray(e) || e.length !== 256)) {
    throw new Error("setMyVoice: 256-dim embeddings required");
  }
  const v = loadVoices(file);
  const prev = v.people.find((p) => p.id === ME);
  const me = {
    id: ME, name, isMe: true,
    embeddings: embeddings.slice(-MAX_EMBEDDINGS),
    mean: meanOf(embeddings),
    createdAt: prev?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    sources: ["enroll"],
  };
  v.people = [me, ...v.people.filter((p) => p.id !== ME)];
  saveVoices(v, file);
  return { id: ME, samples: me.embeddings.length };
}

// Hard delete: the vectors are gone, not hidden.
export function forgetVoice(id, file = voicesFile()) {
  const v = loadVoices(file);
  const before = v.people.length;
  v.people = v.people.filter((p) => p.id !== id);
  if (v.people.length === before) return { ok: false, reason: `no voice ${id}` };
  saveVoices(v, file);
  return { ok: true };
}

// What a segment's `voices` scores say about who spoke it, for the mic:
// "me", "other" (someone else's voice reached your mic), or null (too short
// to print, no profile, or in between).
export function micVoice(seg) {
  const me = seg.voices?.find((v) => v.id === ME);
  if (!me) return null;
  if (me.score >= SAME_VOICE) return "me";
  if (me.score < OTHER_VOICE) return "other";
  return null;
}

// Record (or replay) an enrollment with the helper. onLevel({ db, seconds })
// drives the meter. Resolves the helper's enrollment result; keep it with
// setMyVoice when it has no error. stop() ends the recording early.
let enrolling = null;
export const isEnrolling = () => enrolling !== null;

// test: a few seconds to check "is this me?" (resolves meScore), not a profile.
export function recordEnrollment({ seconds = 30, test = false, replay, bin = PARAKEET_BIN, file = voicesFile(), onLevel = () => {} } = {}) {
  if (enrolling) throw new Error("already recording a voice sample");
  if (!existsSync(bin)) throw new Error("voice enrollment needs the live parakeet helper: npm run build:parakeet");
  const args = ["--enroll", "--seconds", String(seconds)];
  if (existsSync(file)) args.push("--voices", file);
  if (replay) args.push("--replay", replay);
  if (test) args.push("--test");
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  const run = { child, stop: () => { try { child.stdin.write("stop\n"); } catch {} } };
  enrolling = run;
  run.done = new Promise((resolve) => {
    let buf = "";
    let result = null;
    let failure = null;
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === "level") onLevel({ db: msg.db, seconds: msg.seconds });
        else if (msg.kind === "enrollment") result = msg;
        else if (msg.kind === "status" && msg.state !== "listening") failure = `${msg.state}${msg.note ? ` — ${msg.note}` : ""}`;
      }
    });
    child.stderr.on("data", () => {});
    const settle = (error) => {
      if (enrolling === run) enrolling = null;
      if (result) resolve(result.error ? { ok: false, reason: result.error, ...summary(result) } : { ok: true, ...summary(result), embeddings: result.embeddings });
      else resolve({ ok: false, reason: failure ?? error ?? "recording ended without a result" });
    };
    child.on("error", (err) => settle(`spawn failed: ${err.message}`));
    child.on("close", (code) => settle(code === 0 ? null : `helper exited with code ${code}`));
  });
  return run;
}

export function stopEnrollment() {
  enrolling?.stop();
  return { ok: !!enrolling };
}

const summary = (r) => ({
  seconds: r.seconds, voiced: r.voiced, windows: r.windows, consistency: r.consistency, meScore: r.meScore, peakDb: r.peakDb,
});
