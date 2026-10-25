// Meeting mode on Apple Silicon: real model, both streams, Main's own path.
// macOS `say` renders a short call: you speak, they answer, you reply. Their
// line is also mixed into the mic 50 ms late, the way built-in speakers leak
// into the built-in mic (docs/MEETING-MODE.md, Phase 0): −30 dB (quiet room,
// low volume) and −12 dB (loud speakers, heard live; the mic transcribes it).
// The
// helper replays both tracks through its live pipeline (`--replay-mic/-system`)
// and startMeeting must produce You / Them / You with the echo hidden.
// Needs: npm run build:parakeet.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const BIN = path.join(ROOT, "apps/audio-parakeet/bin/parakeet");
if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("skip: meeting mode is Apple Silicon only");
  process.exit(0);
}
if (!existsSync(BIN)) throw new Error("no live binary: run npm run build:parakeet");
const { startMeeting, stopMeeting, getMeeting } = await import("../apps/main/src/meeting.js");

const RATE = 16000;
const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-meeting-"));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// 16-bit mono PCM in and out (afconvert output has extra chunks: walk them).
function readPcm(file) {
  const b = readFileSync(file);
  let off = 12;
  while (off < b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "data") {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${file}`);
}
function writePcm(file, samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36);
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((x, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), 44 + i * 2));
  writeFileSync(file, b);
}
function speech(name, voice, text) {
  const aiff = path.join(dir, `${name}.aiff`), wav = path.join(dir, `${name}.wav`);
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  return readPcm(wav);
}

async function run(echoDb) {
  const lines = [
    { who: "You", stream: "mic", voice: "Samantha", text: "Morning everyone, the onboarding flow shipped yesterday." },
    { who: "Them", stream: "system", voice: "Daniel", text: "Nice work. Can you send me the release notes before Friday?" },
    { who: "You", stream: "mic", voice: "Samantha", text: "Sure, I will send them this afternoon." },
  ];
  const gap = RATE; // 1 s between turns
  const clips = lines.map((l, i) => speech(`l${i}`, l.voice, l.text));
  const total = gap + clips.reduce((n, c) => n + c.length + gap, 0) + gap;
  const mic = new Float32Array(total), system = new Float32Array(total);
  let at = gap;
  clips.forEach((c, i) => {
    const target = lines[i].stream === "mic" ? mic : system;
    target.set(c, at);
    if (lines[i].stream === "system") {
      const delay = Math.round(0.05 * RATE), gain = 10 ** (echoDb / 20);
      for (let k = 0; k < c.length; k++) mic[at + delay + k] += c[k] * gain; // speaker echo
    }
    at += c.length + gap;
  });
  const tag = `echo${echoDb}`;
  writePcm(path.join(dir, `${tag}-mic.wav`), mic);
  writePcm(path.join(dir, `${tag}-system.wav`), system);

  const events = [];
  const t0 = Date.now();
  const m = startMeeting({
    bin: BIN,
    root: path.join(dir, "meetings"),
    replay: { mic: path.join(dir, `${tag}-mic.wav`), system: path.join(dir, `${tag}-system.wav`) },
    onEvent: (e) => events.push(e),
  });
  const done = await m.done;
  await stopMeeting(); // no-op once it has stopped by itself
  if (done.status !== "done") throw new Error(`meeting ${done.status}: ${done.error}`);
  console.log(`[${tag} dB] replay-ok: ${(Date.now() - t0) / 1000}s for ${(total / RATE).toFixed(1)}s of call`);

  const got = getMeeting(m.id, path.join(dir, "meetings"));
  const want = lines.map((l) => `${l.who}: ${norm(l.text)}`);
  const have = got.transcript.map((s) => `${s.speaker}: ${norm(s.text)}`);
  if (JSON.stringify(have) !== JSON.stringify(want)) {
    throw new Error(`transcript drift\n  want ${JSON.stringify(want)}\n  have ${JSON.stringify(have)}`);
  }
  console.log(`transcript-ok:\n${got.text.split("\n").map((l) => "  " + l).join("\n")}`);

  const hidden = events.filter((e) => e.type === "segment" && e.segment.echo);
  if (echoDb >= -15 && !hidden.length) throw new Error("loud echo was never caught as a mic segment: the filter went untested");
  if (hidden.length) console.log(`echo-ok: ${hidden.length} mic segment(s) hidden (${hidden.map((e) => e.segment.echo).join(", ")})`);
  else console.log("echo-ok: the echo never became a mic segment");
  if (!events.some((e) => e.type === "partial" && e.speaker === "Them")) throw new Error("no live captions from the system stream");
  for (const f of ["mic.wav", "system.wav", "meta.json", "transcript.jsonl", "segments.jsonl"]) {
    if (!existsSync(path.join(got.dir, f))) throw new Error(`missing ${f}`);
  }
  console.log("files-ok: mic.wav system.wav meta.json transcript.jsonl segments.jsonl");
}

try {
  await run(-30);
  await run(-12);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
