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
const { startMeeting, stopMeeting, getMeeting, whisperModel, SOMEONE_ELSE, nameSpeaker, speakersToName } = await import("../apps/main/src/meeting.js");
const { recordEnrollment, setMyVoice } = await import("../apps/main/src/voices.js");

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

const ENGLISH = [
  { who: "You", stream: "mic", voice: "Samantha", text: "Morning everyone, the onboarding flow shipped yesterday." },
  { who: "Them", stream: "system", voice: "Daniel", text: "Nice work. Can you send me the release notes before Friday?" },
  { who: "You", stream: "mic", voice: "Samantha", text: "Sure, I will send them this afternoon." },
];
// Whisper (Hindi + Hinglish): you answer in Hindi; Apex writes it romanized.
// Spelling varies (doonga / dunga), so lines are checked by key words.
const HINDI = [
  { who: "Them", stream: "system", voice: "Daniel", text: "Can you send me the release notes before Friday?", keys: ["release", "notes", "friday"] },
  { who: "You", stream: "mic", voice: "Lekha", text: "हाँ, मैं आज शाम तक रिलीज़ नोट्स भेज दूँगा।", keys: ["aaj", "release", "notes", "bhej"] },
];

// Voiceprints (Phase 2): Samantha enrolls as you; Moira talks into your mic
// with no call audio and must come out as someone else, not You.
const VOICES = [
  { who: "You", stream: "mic", voice: "Samantha", text: "Morning everyone, the onboarding flow shipped yesterday." },
  { who: "Them", stream: "system", voice: "Daniel", text: "Nice work. Can you send me the release notes before Friday?" },
  { who: SOMEONE_ELSE, stream: "mic", voice: "Moira", text: "Sorry to interrupt, is this room booked after lunch?" },
  { who: "You", stream: "mic", voice: "Samantha", text: "Sure, I will send them this afternoon." },
];

// Phase 3: three people on the call; after stop they become Speaker A/B/C,
// lettered by who spoke first.
const PANEL = [
  { who: "You", stream: "mic", voice: "Samantha", text: "Morning everyone, let's go through the release." },
  { who: "Speaker A", stream: "system", voice: "Daniel", text: "The billing service is ready for the rollout on Thursday." },
  { who: "Speaker B", stream: "system", voice: "Moira", text: "The migration script still needs one more review before then." },
  { who: "Speaker C", stream: "system", voice: "Aman", text: "I can take that review today, I already read the schema changes." },
  { who: "Speaker A", stream: "system", voice: "Daniel", text: "Great, then we are on track for Thursday." },
  { who: "You", stream: "mic", voice: "Samantha", text: "Perfect, thanks everyone." },
];

// Phase 4: after naming the panel, a later meeting with the same people (new
// lines, new order) must come out with their names and nothing to ask.
const PANEL_AGAIN = [
  { who: "Moira", stream: "system", voice: "Moira", text: "Quick update, the migration review is done and approved." },
  { who: "Aman", stream: "system", voice: "Aman", text: "I also added the missing index on the orders table." },
  { who: "You", stream: "mic", voice: "Samantha", text: "Nice, that unblocks the rollout." },
  { who: "Daniel", stream: "system", voice: "Daniel", text: "Then I will start the deployment this afternoon." },
];

// English + Hinglish (hybrid): both engines on every line; English lines must
// come from Parakeet (exact), the Hindi one from Whisper (romanized).
const MIXED = [
  { who: "Them", stream: "system", voice: "Daniel", text: "Can you send me the release notes before Friday?", engine: "parakeet" },
  { who: "You", stream: "mic", voice: "Lekha", text: "हाँ, मैं आज शाम तक रिलीज़ नोट्स भेज दूँगा।", keys: ["aaj", "release", "notes", "bhej"], engine: "whisper" },
  { who: "Them", stream: "system", voice: "Daniel", text: "Great, and please add the migration steps to the notes.", engine: "parakeet" },
];

async function enrollSamantha() {
  const said = "Hi Jarvis, this is my voice. I usually spend the morning on code reviews and the afternoon in meetings with the team. " +
    "When something breaks in production, I want a short summary first and the details after. " +
    "Please keep the release notes short, and send me the open questions before the end of the day.";
  const pcm = speech("enroll", "Samantha", said);
  const wav = path.join(dir, "enroll-in.wav");
  writePcm(wav, pcm);
  const file = path.join(dir, "people.json");
  const r = await recordEnrollment({ replay: wav, file }).done;
  if (!r.ok) throw new Error(`enrollment: ${r.reason}`);
  setMyVoice({ embeddings: r.embeddings, name: "Samantha" }, file);
  console.log(`enroll-ok: ${r.voiced} s of speech, ${r.windows} windows, consistency ${r.consistency.mean}`);
  return file;
}

async function run(echoDb, { engine = "parakeet", lines = ENGLISH, voices = null } = {}) {
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
  const tag = `${engine}${voices ? "-voices" : ""}-echo${echoDb}`;
  writePcm(path.join(dir, `${tag}-mic.wav`), mic);
  writePcm(path.join(dir, `${tag}-system.wav`), system);

  const events = [];
  const t0 = Date.now();
  const m = startMeeting({
    bin: BIN,
    root: path.join(dir, "meetings"),
    engine,
    voices,
    replay: { mic: path.join(dir, `${tag}-mic.wav`), system: path.join(dir, `${tag}-system.wav`) },
    onEvent: (e) => events.push(e),
  });
  const done = await m.done;
  await stopMeeting(); // no-op once it has stopped by itself
  if (done.status !== "done") throw new Error(`meeting ${done.status}: ${done.error}`);
  console.log(`[${tag} dB] replay-ok: ${(Date.now() - t0) / 1000}s for ${(total / RATE).toFixed(1)}s of call`);

  const got = getMeeting(m.id, path.join(dir, "meetings"));
  const heard = events.filter((e) => e.type === "segment").map((e) => `${e.segment.speaker}${e.segment.echo ? `(echo:${e.segment.echo})` : ""} ${e.segment.start}-${e.segment.end}${e.segment.voices ? ` me=${e.segment.voices.find((v) => v.id === "me")?.score}` : ""}: ${e.segment.text}`);
  const drift = () => new Error(`transcript drift\n  want ${JSON.stringify(lines.map((l) => `${l.who}: ${l.text}`))}\n  have ${JSON.stringify(got.transcript.map((s) => `${s.speaker}: ${s.text}`))}\n  heard ${JSON.stringify(heard, null, 2)}`);
  if (got.transcript.map((s) => s.speaker).join() !== lines.map((l) => l.who).join()) throw drift();
  got.transcript.forEach((s, i) => {
    const ok = lines[i].keys ? lines[i].keys.every((k) => norm(s.text).includes(k)) : norm(s.text) === norm(lines[i].text);
    if (!ok) throw drift();
    if (lines[i].engine && s.engine !== lines[i].engine) throw new Error(`line ${i + 1} came from ${s.engine}, expected ${lines[i].engine}: ${s.text} (other: ${s.alt})`);
  });
  console.log(`transcript-ok:\n${got.text.split("\n").map((l) => "  " + l).join("\n")}`);

  const hidden = events.filter((e) => e.type === "segment" && e.segment.echo);
  if (echoDb >= -15 && !hidden.length) throw new Error("loud echo was never caught as a mic segment: the filter went untested");
  if (hidden.length) console.log(`echo-ok: ${hidden.length} mic segment(s) hidden (${hidden.map((e) => e.segment.echo).join(", ")})`);
  else console.log("echo-ok: the echo never became a mic segment");
  // Whisper captions every 2.5 s, longer than these short lines.
  if (engine === "parakeet" && !events.some((e) => e.type === "partial" && e.speaker === "Them")) throw new Error("no live captions from the system stream");
  for (const f of ["mic.wav", "system.wav", "meta.json", "transcript.jsonl", "segments.jsonl"]) {
    if (!existsSync(path.join(got.dir, f))) throw new Error(`missing ${f}`);
  }
  console.log("files-ok: mic.wav system.wav meta.json transcript.jsonl segments.jsonl");
  return got;
}

try {
  await run(-30);
  await run(-12);
  const samantha = await enrollSamantha();
  await run(-12, { lines: VOICES, voices: samantha });
  const panel = await run(-12, { lines: PANEL, voices: samantha });
  // Name them the way you would from the deck: by the voice you hear.
  const ask = speakersToName(panel);
  const byLabel = { "Speaker A": "Daniel", "Speaker B": "Moira", "Speaker C": "Aman" };
  if (ask.map((s) => s.label).join() !== "Speaker A,Speaker B,Speaker C") throw new Error(`asked about ${ask.map((s) => s.label)}`);
  for (const sp of ask) nameSpeaker(panel.id, sp.id, { name: byLabel[sp.label] }, { root: path.join(dir, "meetings"), voices: samantha });
  console.log(`named-ok: ${ask.map((s) => `${s.label} → ${byLabel[s.label]}`).join(", ")}`);
  const again = await run(-12, { lines: PANEL_AGAIN, voices: samantha });
  const left = speakersToName(again);
  if (left.length) throw new Error(`still asking about ${left.map((s) => s.label)}`);
  console.log("remembered-ok: the next meeting knew everyone by voice");
  if (existsSync(whisperModel())) await run(-12, { engine: "whisper", lines: HINDI });
  else console.log("skip whisper: no model (npm run fetch:whisper-model)");
  if (existsSync(whisperModel())) {
    await run(-12, { engine: "hybrid", lines: MIXED });
    console.log("hybrid-ok: English lines from Parakeet, the Hindi line from Whisper");
  }
} finally {
  if (process.env.PROVE_KEEP) console.log(`kept fixtures in ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
