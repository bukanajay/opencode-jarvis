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

// Phase 4: someone you named after a meeting. The speaker's call voiceprint
// joins the person with that id, else the person with that name (so naming
// "Ravi" twice builds one Ravi), else a new person. Samples are capped; the
// oldest go first, so a voice that changes (new headset) keeps up.
export function rememberVoice({ name, personId, embedding, source }, file = voicesFile(), now = new Date()) {
  const clean = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!personId && !clean) throw new Error("rememberVoice: a name is required");
  if (!Array.isArray(embedding) || embedding.length !== 256) throw new Error("rememberVoice: 256-dim embedding required");
  const v = loadVoices(file);
  let p = personId
    ? v.people.find((x) => x.id === personId)
    : v.people.find((x) => x.id !== ME && x.name.toLowerCase() === clean.toLowerCase());
  if (personId && !p) throw new Error(`no voice ${personId}`);
  if (p?.id === ME) throw new Error("that is your own voice; record it again from Settings instead");
  if (!p) {
    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "person";
    let id = `p-${slug}`;
    for (let n = 2; v.people.some((x) => x.id === id); n++) id = `p-${slug}-${n}`;
    p = { id, name: clean, isMe: false, embeddings: [], createdAt: now.toISOString(), sources: [] };
    v.people.push(p);
  }
  p.embeddings = [...p.embeddings, embedding].slice(-MAX_EMBEDDINGS);
  p.mean = meanOf(p.embeddings);
  p.updatedAt = now.toISOString();
  if (source && !p.sources.includes(source)) p.sources = [...p.sources, source];
  saveVoices(v, file);
  return { id: p.id, name: p.name, samples: p.embeddings.length };
}

export function renameVoice(id, name, file = voicesFile()) {
  const clean = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return { ok: false, reason: "a name is required" };
  const v = loadVoices(file);
  const p = v.people.find((x) => x.id === id);
  if (!p) return { ok: false, reason: `no voice ${id}` };
  p.name = clean;
  saveVoices(v, file);
  return { ok: true, id, name: clean };
}

// Two entries that are the same person: samples and sources move to `into`.
export function mergeVoices(from, into, file = voicesFile()) {
  if (from === into) return { ok: false, reason: "same person" };
  const v = loadVoices(file);
  const a = v.people.find((x) => x.id === from), b = v.people.find((x) => x.id === into);
  if (!a || !b) return { ok: false, reason: "no such voice" };
  if (a.id === ME || b.id === ME) return { ok: false, reason: "your own voice cannot be merged" };
  b.embeddings = [...b.embeddings, ...a.embeddings].slice(-MAX_EMBEDDINGS);
  b.mean = meanOf(b.embeddings);
  b.sources = [...new Set([...(b.sources ?? []), ...(a.sources ?? [])])];
  v.people = v.people.filter((x) => x.id !== from);
  saveVoices(v, file);
  return { ok: true, id: into, samples: b.embeddings.length };
}

// Best known person (not you) for a voiceprint: { id, name, score } or null.
export function bestVoice(print, people = loadVoices().people) {
  let best = null;
  for (const p of people) {
    if (p.id === ME || !p.mean) continue;
    const score = p.mean.reduce((s, x, i) => s + x * print[i], 0);
    if (!best || score > best.score) best = { id: p.id, name: p.name, score: Math.round(score * 100) / 100 };
  }
  return best;
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
