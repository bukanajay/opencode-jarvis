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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PARAKEET_BIN = path.join(here, "../../audio-parakeet/bin/parakeet");

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
  return {
    setRoute(r) { currentRoute = r; },
    add(raw) {
      const seg = {
        id: raw.id, stream: raw.stream, speaker: speakerFor(raw.stream), text: raw.text,
        start: raw.start, end: raw.end, micDb: raw.micDb, systemDb: raw.systemDb,
        micVoiced: raw.micVoiced, systemVoiced: raw.systemVoiced, echo: null,
      };
      segs.push(seg);
      const changed = [seg];
      if (seg.stream === "mic") seg.echo = echoVerdict(seg, systemSegs(), { route: currentRoute });
      else {
        for (const m of segs) {
          if (m.stream !== "mic" || m.echo || m.end < seg.start - 1.5 || m.start > seg.end + 1.5) continue;
          const v = echoVerdict(m, systemSegs(), { route: currentRoute });
          if (v) { m.echo = v; changed.push(m); }
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

let active = null;
export const isMeetingActive = () => active !== null;
export const activeMeeting = () => (active ? { id: active.id, dir: active.dir, startedAt: active.meta.startedAt, route: active.meta.route } : null);

// onEvent({ type: "segment" | "partial" | "status" | "stopped", ... })
export function startMeeting({ apps = [], bin = PARAKEET_BIN, root = meetingsRoot(), replay, onEvent = () => {}, now = new Date() } = {}) {
  if (active) throw new Error("meeting already running");
  if (!existsSync(bin)) throw new Error("meeting mode needs the live parakeet helper: npm run build:parakeet");
  const { id, dir } = freshDir(root, meetingId(now));
  const meta = { id, startedAt: now.toISOString(), endedAt: null, apps, route: null, status: "recording", error: null, seconds: null };
  const writeMeta = () => writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeMeta();

  const args = ["--meeting", dir, ...apps.flatMap((a) => ["--app", a])];
  if (replay) args.push("--replay-mic", replay.mic, "--replay-system", replay.system);
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  const log = createMeetingLog();
  const segFile = path.join(dir, "segments.jsonl");
  let settle;
  const done = new Promise((r) => { settle = r; });
  const m = { id, dir, meta, child, log, done, stopping: false };
  active = m;

  const finish = (error) => {
    if (meta.status !== "recording") return;
    meta.endedAt = new Date().toISOString();
    meta.status = error ? "failed" : "done";
    meta.error = error ?? null;
    writeFileSync(path.join(dir, "transcript.jsonl"), log.transcript().map((s) => JSON.stringify(s)).join("\n") + (log.transcript().length ? "\n" : ""));
    writeMeta();
    if (active === m) active = null;
    const summary = { id, dir, status: meta.status, error: meta.error, seconds: meta.seconds, segments: log.transcript().length };
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
          onEvent({ type: "segment", meetingId: id, segment: { ...seg } }); // a copy: the log may re-judge it later
        }
      } else if (msg.kind === "partial") {
        onEvent({ type: "partial", meetingId: id, stream: msg.stream, speaker: speakerFor(msg.stream), id: msg.id, text: msg.text ?? "" });
      } else if (msg.kind === "status") {
        if (msg.route) { meta.route = msg.route; log.setRoute(msg.route); writeMeta(); }
        if (msg.state === "stopped") meta.seconds = msg.seconds ?? null;
        if (["mic-denied", "mic-error", "unavailable"].includes(msg.state)) lastError = `${msg.state}${msg.note ? ` — ${msg.note}` : ""}`;
        onEvent({ type: "status", meetingId: id, state: msg.state, note: msg.note ?? "", route: msg.route });
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
  return { ...meta, dir, transcript, text: transcriptText(transcript) };
}
