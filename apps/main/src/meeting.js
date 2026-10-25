// Meeting mode, Main side (docs/MEETING-MODE.md, Phase 1). Owns the one
// long-running `parakeet --meeting` helper, stores each meeting under
// ~/.config/jarvis/meetings/<yyyy-mm-dd-hhmm>/, labels streams (mic = You,
// system = Them) and hides speaker echo: the mic hearing the call through
// the speakers, which would otherwise put every remote sentence in twice.
//
// Files per meeting: mic.wav + system.wav (helper), segments.jsonl (every
// segment as heard, echo flag included), transcript.jsonl (clean, written at
// stop), meta.json.
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bestVoice, listVoices, loadVoices, micVoice, OTHER_VOICE, rememberVoice, SAME_VOICE, voicesFile, ME } from "./voices.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PARAKEET_BIN = path.join(here, "../../audio-parakeet/bin/parakeet");

// Speech engines for a meeting. Parakeet: English and European languages,
// fastest. Whisper: Hindi and Hinglish (Oriserve Whisper-Hindi2Hinglish-Apex
// writes Hindi as romanized Hinglish), via whisper.cpp in the same helper.
export const ENGINES = {
  parakeet: { label: "English (Parakeet)" },
  whisper: { label: "Hindi + Hinglish (Whisper)", language: "hi" },
  // Both on every line, the better one kept (chooseLine): mixed meetings.
  hybrid: { label: "English + Hinglish (both, per line)", language: "hi" },
};
export function whisperModel(env = process.env) {
  return env.JARVIS_WHISPER_MODEL ?? path.join(os.homedir(), ".config", "jarvis", "models", "ggml-apex-hinglish-q8_0.bin");
}

export function meetingsRoot(env = process.env) {
  return env.JARVIS_MEETINGS_DIR ?? path.join(os.homedir(), ".config", "jarvis", "meetings");
}

const pad2 = (n) => String(n).padStart(2, "0");
export function meetingId(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

function freshDir(root, id) {
  let name = id;
  for (let n = 2; existsSync(path.join(root, name)); n++) name = `${id}-${n}`;
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return { id: name, dir };
}

export const speakerFor = (stream) => (stream === "mic" ? "You" : "Them");

// English + Hinglish meetings (engine "hybrid"): every line comes back from
// both Parakeet and Whisper, and this picks one. Whisper (Apex) writes Hindi
// as romanized Hinglish, so a line whose Whisper text is full of Hindi words
// was Hinglish: Whisper's. Otherwise Parakeet's, which hears English better
// ("tech stack", "inferPulse") — unless Parakeet drifted into another
// European language, its tell on Hindi it could not follow ("Y lo que sí").
// Whisper alone in Devanagari is noise (Apex writes real Hindi romanized).
// Measured on the first real call: English lines 0.00 Hindi words, Hinglish
// lines 0.56–1.00.
const HINDI_WORDS = new Set(("hai hain ho hoon hu main mai mein mera mere meri mujhe mujhko kya kyun kyon kaise kab kahan nahin nahi na " +
  "ka ki ke ko se par aur yah yeh ye vah woh wo tha thi abhi bhi kar karo karna karenge kiya kiye raha rahe rahi rahenge ek hum hamse " +
  "hamara tum tumhe aap apna apne wala wali wale lenge loonga lunga denge dunga doonga dekh dekho dekhte dekhate dekhana chalo theek thik " +
  "accha achha acha haan ji ab jab tab jo sab kuch bahut baat baad pehle phir kal aaj dikkat matlab islie isliye lekin paega sakte " +
  "sakta banaaya banaya karoon lete saath logon jaoonga jaunga thoda zyada jaldi bilkul shayad zaroor").split(" "));
const FOREIGN = /[À-ÖØ-öø-ÿ\u0400-\u04FF]|\b(?:que|qué|lo|los|las|el|ich|und|nicht|ist|das|der|die|gut|aber|gell|nie|je|est|le|les|une|et|pas|ну|да|нет)\b/i;
const DEVANAGARI = /[\u0900-\u097F]/;
export function hindiShare(text) {
  const w = String(text ?? "").toLowerCase().match(/[a-z']+/g) ?? [];
  const hits = w.filter((x) => HINDI_WORDS.has(x)).length;
  return { hits, words: w.length, share: w.length ? hits / w.length : 0 };
}
export function chooseLine({ parakeet = "", whisper = "" } = {}) {
  const p = String(parakeet ?? "").trim(), w = String(whisper ?? "").trim();
  const latinW = w && !(DEVANAGARI.test(w) && !/[a-z]/i.test(w));
  if (!p) return latinW ? { text: w, engine: "whisper", alt: "" } : { text: "", engine: null, alt: w };
  if (!latinW) return { text: p, engine: "parakeet", alt: w };
  const h = hindiShare(w);
  const hinglish = (h.hits >= 2 && h.share >= 0.2) || (h.hits >= 1 && h.words <= 2);
  if (hinglish || FOREIGN.test(p)) return { text: w, engine: "whisper", alt: p };
  return { text: p, engine: "parakeet", alt: w };
}
// A mic line whose voiceprint is clearly not yours, with no call audio to
// blame it on: someone next to you.
export const SOMEONE_ELSE = "Someone else";

const tokens = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);

// Is this mic segment the call leaking back in through the speakers?
// text:  most of its words were said on the system stream at the same time
//        (Parakeet transcribes the echo almost verbatim, Phase 0 finding 7).
// level: the call was playing for most of it and the mic was far quieter
//        than the call (speaker coupling measured −35…−41 dB). Only when the
//        route can leak (not headphones / bluetooth).
export function echoVerdict(mic, systemSegs, { route } = {}) {
  if (mic.stream !== "mic") return null;
  const words = tokens(mic.text);
  const near = systemSegs.filter((s) => s.start <= mic.end + 1.5 && s.end >= mic.start - 1.5);
  if (words.length >= 2 && near.length) {
    const heard = new Set(near.flatMap((s) => tokens(s.text)));
    const shared = words.filter((w) => heard.has(w)).length / words.length;
    if (shared >= 0.6) return "text";
  }
  // One word ("Who", "Okay") is too little to share 60% of by chance, so ask
  // for the same word from the call starting within half a second.
  if (words.length === 1 && near.some((s) => Math.abs(s.start - mic.start) <= 0.5 && tokens(s.text).join(" ") === words[0])) return "text";
  const leaky = route !== "headphones" && route !== "bluetooth";
  if (leaky && (mic.systemVoiced ?? 0) >= 0.6 && mic.micDb != null && mic.systemDb != null && mic.micDb - mic.systemDb <= -25) return "level";
  return null;
}

// Pure transcript state: add segments as they arrive, get back what changed.
// A mic segment can arrive before the system segment that proves it is echo
// (the call's utterance ends later), so system arrivals re-check recent mic.
export function createMeetingLog({ route } = {}) {
  const segs = [];
  let currentRoute = route;
  const systemSegs = () => segs.filter((s) => s.stream === "system");
  // Your voiceprint outranks the word rules: your line is never hidden as
  // echo, and a print that is clearly someone else while the call was
  // playing is the call coming back through the speakers.
  const judgeMic = (m) => {
    if (m.voice === "me") return null;
    if (m.voice === "other" && ((m.systemVoiced ?? 0) >= 0.3 || systemSegs().some((s) => s.start <= m.end && s.end >= m.start))) return "voice";
    return echoVerdict(m, systemSegs(), { route: currentRoute });
  };
  return {
    setRoute(r) { currentRoute = r; },
    add(raw) {
      // Hybrid: both engines' text came back; keep the better one.
      const pick = raw.texts ? chooseLine(raw.texts) : null;
      if (pick && !pick.text) return [];
      const seg = {
        id: raw.id, stream: raw.stream, speaker: speakerFor(raw.stream), text: pick ? pick.text : raw.text,
        ...(pick ? { engine: pick.engine, alt: pick.alt } : {}),
        start: raw.start, end: raw.end, micDb: raw.micDb, systemDb: raw.systemDb,
        micVoiced: raw.micVoiced, systemVoiced: raw.systemVoiced, echo: null,
        ...(raw.voices ? { voices: raw.voices, voiced: raw.voiced } : {}),
        ...(raw.print ? { print: raw.print } : {}),
      };
      segs.push(seg);
      const changed = [seg];
      if (seg.stream === "mic") {
        seg.voice = micVoice(seg);
        seg.echo = judgeMic(seg);
        if (seg.voice === "other" && !seg.echo) seg.speaker = SOMEONE_ELSE;
      } else {
        for (const m of segs) {
          if (m.stream !== "mic" || m.echo || m.end < seg.start - 1.5 || m.start > seg.end + 1.5) continue;
          const v = judgeMic(m);
          if (v) { m.echo = v; m.speaker = speakerFor("mic"); changed.push(m); }
        }
      }
      return changed;
    },
    all: () => segs.slice(),
    transcript: () => segs.filter((s) => !s.echo).sort((a, b) => a.start - b.start),
  };
}

const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
};

// What Jarvis reads when you discuss the meeting.
export function transcriptText(segs) {
  return segs.map((s) => `[${clock(s.start)}] ${s.speaker}: ${s.text}`).join("\n");
}

// Phase 3: after the meeting, `parakeet --diarize` splits the call side into
// speakers (turns + one voiceprint and clip each); this puts names on them.
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// Which speaker said each call-side line: the speaker whose turns overlap it
// most; else the one its own voiceprint matches; else the nearest turn.
// With a single voice on the call, every call-side line is theirs (short
// replies like "Yes sir" fall outside the turns and carry no voiceprint).
// Speakers matching a known voice take its name ("Ravi?" when it is close but
// not sure, OTHER_VOICE..SAME_VOICE); with two or more unknown voices they
// become Speaker A, B, …; a single unknown stays "Them".
export function assignSpeakers(segs, { turns = [], speakers = [] }, people = []) {
  const firstTurn = (id) => turns.find((t) => t.speaker === id)?.start ?? Infinity;
  const ordered = [...speakers].sort((a, b) => firstTurn(a.id) - firstTurn(b.id));
  const named = ordered.map((sp) => {
    const best = (sp.voices ?? []).filter((v) => v.id !== ME).sort((a, b) => b.score - a.score)[0];
    const person = best && best.score >= OTHER_VOICE ? people.find((p) => p.id === best.id) : null;
    return { ...sp, match: person ? { id: person.id, name: person.name, score: best.score, uncertain: best.score < SAME_VOICE } : null };
  });
  const unknown = named.filter((sp) => !sp.match);
  for (const sp of named) {
    sp.label = sp.match
      ? `${sp.match.name}${sp.match.uncertain ? "?" : ""}`
      : unknown.length >= 2 ? `Speaker ${String.fromCharCode(65 + unknown.indexOf(sp))}` : speakerFor("system");
  }
  const byId = new Map(named.map((sp) => [sp.id, sp]));
  const who = new Map();
  for (const seg of segs) {
    if (seg.stream !== "system" || !named.length) continue;
    const dur = Math.max(0.01, seg.end - seg.start);
    const overlap = new Map();
    for (const t of turns) {
      const o = Math.min(seg.end, t.end) - Math.max(seg.start, t.start);
      if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + o);
    }
    let id = [...overlap].sort((a, b) => b[1] - a[1])[0];
    id = id && (id[1] >= 0.5 || id[1] >= 0.3 * dur) ? id[0] : null;
    if (!id && seg.print) {
      const best = named.filter((sp) => sp.print).map((sp) => [sp.id, cos(seg.print, sp.print)]).sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= SAME_VOICE) id = best[0];
    }
    if (!id) {
      const near = turns.map((t) => [t.speaker, Math.max(0, t.start - seg.end, seg.start - t.end)]).sort((a, b) => a[1] - b[1])[0];
      if (near && near[1] <= 3) id = near[0];
    }
    if (!id && named.length === 1) id = named[0].id;
    if (id && byId.has(id)) who.set(seg.id, byId.get(id));
  }
  return { speakers: named, who };
}

export function diarizeMeeting(dir, { bin = PARAKEET_BIN, voices = voicesFile() } = {}) {
  return new Promise((resolve) => {
    const args = ["--diarize", dir];
    if (voices && existsSync(voices)) args.push("--voices", voices);
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = { turns: [], speakers: [] };
    let buf = "";
    let error = null;
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === "turns") out.turns = msg.turns ?? [];
        else if (msg.kind === "speaker") out.speakers.push(msg);
        else if (msg.kind === "status" && msg.state !== "diarized") error = `${msg.state}${msg.note ? ` — ${msg.note}` : ""}`;
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", (err) => resolve({ error: `diarize spawn failed: ${err.message}` }));
    child.on("close", (code) => resolve(code === 0 && !error ? out : { error: error ?? `diarize exited with code ${code}` }));
  });
}

// Label call-side lines from a diarization (mutates segs), keep the speakers'
// voiceprints in speakers.json, and return the speakers for meta.json plus
// the lines whose label changed.
function applyDiarization(dir, segs, d, voices) {
  const people = voices && existsSync(voices) ? listVoices(voices) : [];
  const { speakers, who } = assignSpeakers(segs, d, people);
  const changed = [];
  for (const seg of segs) {
    const sp = who.get(seg.id);
    if (!sp) continue;
    seg.speakerId = sp.id;
    if (seg.speaker !== sp.label) { seg.speaker = sp.label; changed.push(seg); }
  }
  writeFileSync(path.join(dir, "speakers.json"), JSON.stringify(speakers)); // with voiceprints, for naming them later
  const metaSpeakers = speakers.map(({ print, voices: v, kind, ...sp }) => ({ ...sp, clip: sp.clip ? path.relative(dir, sp.clip) : null }));
  return { metaSpeakers, changed };
}

// Tell the call-side speakers apart in a meeting that is already saved (one
// recorded before this existed, or after you forgot someone). Same steps as
// at stop; the transcript is rewritten from segments.jsonl.
export async function identifySpeakers(id, { root = meetingsRoot(), voices = voicesFile(), bin = PARAKEET_BIN } = {}) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error("bad meeting id");
  if (active?.id === id) throw new Error("that meeting is still running");
  const dir = path.join(root, id);
  const d = await diarizeMeeting(dir, { bin, voices });
  if (d.error) throw new Error(d.error);
  const segs = [...new Map(readJsonl(path.join(dir, "segments.jsonl")).map((s) => [s.id, s])).values()];
  const { metaSpeakers } = applyDiarization(dir, segs, d, voices);
  const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
  // People you already named here stay confirmed when the same voice comes back.
  const confirmed = new Set((meta.speakers ?? []).filter((sp) => sp.named).map((sp) => sp.match?.id));
  for (const sp of metaSpeakers) if (sp.match && !sp.match.uncertain && confirmed.has(sp.match.id)) sp.named = true;
  meta.speakers = metaSpeakers;
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeJsonl(path.join(dir, "transcript.jsonl"), segs.filter((s) => !s.echo).sort((a, b) => a.start - b.start).map(({ print, ...s }) => s));
  return getMeeting(id, root);
}

let active = null;
export const isMeetingActive = () => active !== null;
export const activeMeeting = () => (active ? { id: active.id, dir: active.dir, startedAt: active.meta.startedAt, route: active.meta.route } : null);

// onEvent({ type: "segment" | "partial" | "status" | "stopped", ... })
export function startMeeting({ apps = [], engine = "parakeet", model = whisperModel(), voices = voicesFile(), bin = PARAKEET_BIN, root = meetingsRoot(), replay, diarize = true, onEvent = () => {}, now = new Date() } = {}) {
  if (active) throw new Error("meeting already running");
  if (!ENGINES[engine]) throw new Error(`unknown speech engine: ${engine}`);
  if (!existsSync(bin)) throw new Error("meeting mode needs the live parakeet helper: npm run build:parakeet");
  if (engine !== "parakeet" && !existsSync(model)) throw new Error(`Hindi/Hinglish needs the Whisper model: npm run fetch:whisper-model (expected ${model})`);
  const { id, dir } = freshDir(root, meetingId(now));
  const meta = { id, startedAt: now.toISOString(), endedAt: null, apps, engine, route: null, status: "recording", error: null, seconds: null };
  const writeMeta = () => writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeMeta();

  const args = ["--meeting", dir, ...apps.flatMap((a) => ["--app", a])];
  if (engine !== "parakeet") args.push("--engine", engine, "--model", model, "--language", ENGINES[engine].language);
  if (voices && existsSync(voices)) args.push("--voices", voices);
  if (replay) args.push("--replay-mic", replay.mic, "--replay-system", replay.system);
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  const log = createMeetingLog();
  const segFile = path.join(dir, "segments.jsonl");
  let settle;
  const done = new Promise((r) => { settle = r; });
  const m = { id, dir, meta, child, log, done, stopping: false };
  active = m;

  let finishing = false;
  const finish = async (error) => {
    if (meta.status !== "recording" || finishing) return;
    finishing = true;
    // Who was who on the call side, before the transcript is written.
    if (!error && diarize && log.all().some((s) => s.stream === "system" && !s.echo)) {
      onEvent({ type: "status", meetingId: id, state: "diarizing", note: "telling the other speakers apart" });
      const d = await diarizeMeeting(dir, { bin, voices });
      if (d.error) meta.diarizeError = d.error;
      else {
        const { metaSpeakers, changed } = applyDiarization(dir, log.all(), d, voices);
        for (const seg of changed) {
          const { print, ...shown } = seg;
          if (!seg.echo) onEvent({ type: "segment", meetingId: id, segment: shown });
        }
        meta.speakers = metaSpeakers;
      }
    }
    meta.endedAt = new Date().toISOString();
    meta.status = error ? "failed" : "done";
    meta.error = error ?? null;
    const clean = log.transcript().map(({ print, ...s }) => s); // voiceprints stay in segments.jsonl
    writeFileSync(path.join(dir, "transcript.jsonl"), clean.map((s) => JSON.stringify(s)).join("\n") + (clean.length ? "\n" : ""));
    writeMeta();
    if (active === m) active = null;
    let toName = 0;
    try { toName = speakersToName(getMeeting(id, root)).length; } catch {}
    const summary = { id, dir, status: meta.status, error: meta.error, seconds: meta.seconds, segments: log.transcript().length, speakers: meta.speakers?.length ?? 0, toName };
    onEvent({ type: "stopped", ...summary });
    settle(summary);
  };

  let buf = "";
  let lastError = null;
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.kind === "segment") {
        for (const seg of log.add(msg)) {
          appendFileSync(segFile, JSON.stringify(seg) + "\n");
          const { print, ...shown } = seg; // a copy without the voiceprint: the log may re-judge it later
          onEvent({ type: "segment", meetingId: id, segment: shown });
        }
      } else if (msg.kind === "partial") {
        onEvent({ type: "partial", meetingId: id, stream: msg.stream, speaker: speakerFor(msg.stream), id: msg.id, text: msg.text ?? "" });
      } else if (msg.kind === "status") {
        if (msg.route) { meta.route = msg.route; log.setRoute(msg.route); writeMeta(); }
        if (msg.state === "stopped") meta.seconds = msg.seconds ?? null;
        if (["mic-denied", "mic-error", "unavailable"].includes(msg.state)) lastError = `${msg.state}${msg.note ? ` — ${msg.note}` : ""}`;
        onEvent({ type: "status", meetingId: id, state: msg.state, note: msg.note ?? "", route: msg.route, engine: msg.engine });
      }
    }
  });
  child.stderr.on("data", () => {}); // keep the pipe drained
  child.on("error", (err) => finish(`spawn failed: ${err.message}`));
  child.on("close", (code) => finish(code === 0 ? null : lastError ?? `helper exited with code ${code}`));
  return m;
}

// Graceful: the helper commits what is being said, closes the WAVs, exits.
export async function stopMeeting({ graceMs = 15000 } = {}) {
  const m = active;
  if (!m) return { ok: false, reason: "no meeting running" };
  if (!m.stopping) {
    m.stopping = true;
    try { m.child.stdin.write("stop\n"); } catch {}
    const term = setTimeout(() => { try { m.child.kill("SIGTERM"); } catch {} }, graceMs);
    const kill = setTimeout(() => { try { m.child.kill("SIGKILL"); } catch {} }, graceMs + 5000);
    m.done.finally(() => { clearTimeout(term); clearTimeout(kill); });
  }
  return { ok: true, ...(await m.done) };
}

export function listMeetings(root = meetingsRoot()) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => {
      try { return JSON.parse(readFileSync(path.join(root, name, "meta.json"), "utf8")); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// Phase 4: who still needs a name after a meeting. Unknown or unsure voices
// with a clip and enough speech to be worth asking about, each with a line
// they said so you can tell them apart.
const ASK_MIN_SECONDS = 3;
export function speakersToName(meeting) {
  return (meeting.speakers ?? [])
    .filter((sp) => !sp.named && (!sp.match || sp.match.uncertain) && sp.clip && sp.seconds >= ASK_MIN_SECONDS)
    .map((sp) => {
      const lines = meeting.transcript.filter((s) => s.speakerId === sp.id).sort((a, b) => b.text.length - a.text.length);
      return { ...sp, said: lines[0]?.text ?? "" };
    });
}

const readJsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const writeJsonl = (f, rows) => writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));

// Re-match one meeting's call-side speakers against the voices you know now.
// Speakers you named keep their name; letters of the still-unknown stay put.
// `force` names one speaker outright. Returns how many lines changed.
function relabelMeeting(dir, people, force = null) {
  const metaFile = path.join(dir, "meta.json"), spFile = path.join(dir, "speakers.json");
  if (!existsSync(metaFile) || !existsSync(spFile)) return 0;
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  const prints = new Map(JSON.parse(readFileSync(spFile, "utf8")).map((sp) => [sp.id, sp.print]));
  const labels = new Map();
  for (const sp of meta.speakers ?? []) {
    if (force && sp.id === force.speakerId) {
      sp.named = true;
      sp.match = { id: force.person.id, name: force.person.name, score: 1, uncertain: false };
      sp.label = force.person.name;
    } else if (sp.named) {
      const p = people.find((x) => x.id === sp.match?.id);
      if (p) sp.label = sp.match.name = p.name; // renamed since
    } else if (prints.get(sp.id)) {
      const best = bestVoice(prints.get(sp.id), people);
      if (best && best.score >= OTHER_VOICE) {
        sp.match = { ...best, uncertain: best.score < SAME_VOICE };
        sp.label = `${best.name}${sp.match.uncertain ? "?" : ""}`;
      }
    }
    labels.set(sp.id, sp.label);
  }
  let changed = 0;
  const tFile = path.join(dir, "transcript.jsonl");
  const rows = readJsonl(tFile).map((r) => {
    const label = r.speakerId && labels.get(r.speakerId);
    if (!label || label === r.speaker) return r;
    changed += 1;
    return { ...r, speaker: label };
  });
  if (changed) writeJsonl(tFile, rows);
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return changed;
}

// You said who a voice was. Their call voiceprint is remembered under that
// name (voices.js), this meeting is relabelled, and so is every other
// meeting where the same voice is still unnamed.
export function nameSpeaker(meetingId, speakerId, { name, personId } = {}, { root = meetingsRoot(), voices = voicesFile() } = {}) {
  if (!/^[\w-]+$/.test(String(meetingId))) throw new Error("bad meeting id");
  const dir = path.join(root, meetingId);
  const sp = JSON.parse(readFileSync(path.join(dir, "speakers.json"), "utf8")).find((x) => x.id === speakerId);
  if (!sp?.print) throw new Error(`no voiceprint for ${speakerId} in ${meetingId}`);
  const person = rememberVoice({ name, personId, embedding: sp.print, source: `meeting:${meetingId}` }, voices);
  const people = loadVoices(voices).people;
  let relabelled = relabelMeeting(dir, people, { speakerId, person });
  for (const m of listMeetings(root)) {
    if (m.id !== meetingId) relabelled += relabelMeeting(path.join(root, m.id), people);
  }
  return { person, relabelled, meeting: getMeeting(meetingId, root) };
}

// Run a saved meeting through the pipeline again with another engine (most
// often: recorded in English, spoken in Hinglish). Its own WAVs are replayed
// into a scratch folder inside the meeting with the full stop path (echo,
// voiceprints, speakers); the results replace the old ones. The old
// transcript and notes stay beside them as transcript.<engine>.jsonl and
// summary.<engine>.json (notes describe a transcript, so they go stale).
// People you confirmed here stay confirmed when their voice is found again.
export async function retranscribeMeeting(id, { engine = "hybrid", root = meetingsRoot(), voices = voicesFile(), model = whisperModel(), bin = PARAKEET_BIN, onEvent = () => {} } = {}) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error("bad meeting id");
  if (active) throw new Error("a meeting is running; try again when it stops");
  const dir = path.join(root, id);
  const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
  const was = meta.engine ?? "parakeet";
  for (const f of ["mic.wav", "system.wav"]) if (!existsSync(path.join(dir, f))) throw new Error(`${f} is missing; cannot re-transcribe`);
  const work = mkdtempSync(path.join(dir, ".redo-"));
  try {
    const m = startMeeting({
      root: work, engine, model, voices, bin, now: new Date(meta.startedAt),
      replay: { mic: path.join(dir, "mic.wav"), system: path.join(dir, "system.wav") },
      onEvent: (e) => { if (e.type === "status") onEvent(e); },
    });
    const r = await m.done;
    if (r.status !== "done") throw new Error(r.error ?? `re-transcription ${r.status}`);
    const keep = (from, to) => { if (existsSync(path.join(dir, from)) && !existsSync(path.join(dir, to))) renameSync(path.join(dir, from), path.join(dir, to)); };
    keep("transcript.jsonl", `transcript.${was}.jsonl`);
    keep("segments.jsonl", `segments.${was}.jsonl`);
    keep("summary.json", `summary.${was}.json`);
    for (const f of ["transcript.jsonl", "segments.jsonl", "speakers.json", "summary.json"]) rmSync(path.join(dir, f), { force: true });
    rmSync(path.join(dir, "speakers"), { recursive: true, force: true });
    for (const f of ["transcript.jsonl", "segments.jsonl"]) cpSync(path.join(m.dir, f), path.join(dir, f));
    if (existsSync(path.join(m.dir, "speakers"))) cpSync(path.join(m.dir, "speakers"), path.join(dir, "speakers"), { recursive: true });
    if (existsSync(path.join(m.dir, "speakers.json"))) {
      const sp = JSON.parse(readFileSync(path.join(m.dir, "speakers.json"), "utf8"))
        .map((x) => ({ ...x, clip: x.clip ? path.join(dir, path.relative(m.dir, x.clip)) : x.clip }));
      writeFileSync(path.join(dir, "speakers.json"), JSON.stringify(sp));
    }
    const fresh = JSON.parse(readFileSync(path.join(m.dir, "meta.json"), "utf8"));
    const confirmed = new Set((meta.speakers ?? []).filter((x) => x.named).map((x) => x.match?.id));
    for (const x of fresh.speakers ?? []) if (x.match && !x.match.uncertain && confirmed.has(x.match.id)) x.named = true;
    Object.assign(meta, { engine, speakers: fresh.speakers ?? [], diarizeError: fresh.diarizeError, retranscribedAt: new Date().toISOString() });
    delete meta.title;
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return getMeeting(id, root);
}

// Phase 6: keep meeting audio N days (setting meetingAudioDays). Older
// finished meetings lose mic.wav, system.wav and the voice clips; the
// transcript, notes and voiceprints stay, so they still read, discuss and
// recognise people. A meeting without audio cannot be re-transcribed.
const AUDIO_FILES = ["mic.wav", "system.wav"];
export function pruneMeetingAudio(days, { root = meetingsRoot(), now = Date.now() } = {}) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return { meetings: 0, bytes: 0 };
  const cutoff = now - n * 24 * 3600 * 1000;
  let meetings = 0, bytes = 0;
  for (const m of listMeetings(root)) {
    if (m.status === "recording" || m.audioDeletedAt || Date.parse(m.endedAt ?? m.startedAt) > cutoff) continue;
    const dir = path.join(root, m.id);
    const clips = existsSync(path.join(dir, "speakers")) ? readdirSync(path.join(dir, "speakers")).map((f) => path.join("speakers", f)) : [];
    for (const f of [...AUDIO_FILES, ...clips]) {
      const file = path.join(dir, f);
      if (!existsSync(file)) continue;
      bytes += statSync(file).size;
      rmSync(file, { force: true });
    }
    const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
    meta.audioDeletedAt = new Date(now).toISOString();
    for (const sp of meta.speakers ?? []) sp.clip = null;
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    meetings += 1;
  }
  return { meetings, bytes };
}

// Phase 5: the notes the brain wrote for a meeting (meetings-brain.js).
export function saveSummary(id, summary, root = meetingsRoot()) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error("bad meeting id");
  const dir = path.join(root, id);
  writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ ...summary, createdAt: new Date().toISOString() }, null, 2));
  const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
  meta.title = summary.title;
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function getMeeting(id, root = meetingsRoot()) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error("bad meeting id");
  const dir = path.join(root, id);
  const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
  const file = existsSync(path.join(dir, "transcript.jsonl")) ? "transcript.jsonl" : "segments.jsonl";
  const segs = existsSync(path.join(dir, file))
    ? readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  // segments.jsonl (a meeting that never finished) re-appends a segment when
  // it is later judged echo: the last copy wins.
  const transcript = file === "transcript.jsonl"
    ? segs
    : [...new Map(segs.map((s) => [s.id, s])).values()].filter((s) => !s.echo).sort((a, b) => a.start - b.start);
  const summaryFile = path.join(dir, "summary.json");
  const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null;
  return { ...meta, dir, transcript, summary, text: transcriptText(transcript) };
}
