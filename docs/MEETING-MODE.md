# Meeting mode (plan, 2026-10-25)

Jarvis listens to a call happening on this Mac (Teams, Zoom, Meet in a
browser, WhatsApp), writes a speaker-labelled transcript, learns voices, and
lets you discuss the meeting and turn it into actions afterwards. Audio only.

Everything runs on-device. Audio and voiceprints never leave the box; only
transcript text crosses into Main, same rule as `apps/audio-parakeet/protocol.md`.

## Building blocks we already have

- `apps/audio-parakeet` — Parakeet TDT v3 via FluidAudio 0.9.1, energy VAD,
  partial/final protocol. Today it is **one-shot**: it exits after one final.
- FluidAudio 0.9.1 (already vendored) also ships, unused so far:
  - `OfflineDiarizerManager` — pyannote segmentation + WeSpeaker 256-d
    embeddings + VBx clustering (batch, best quality).
  - `DiarizerManager` + `SpeakerManager` — streaming diarization with a
    known-speaker database (`initializeKnownSpeakers`, `upsertSpeaker`,
    `Speaker` is `Codable`, keeps up to 50 raw embeddings per speaker).
  - `diarizer.extractEmbedding(samples)` — the enrollment primitive.
- `apps/main/src/audio.js` — spawns helpers, parses the line protocol.
- Brain, decision inbox, connectors (Linear, Slack, Calendar, Gmail) for the
  "plan actions" part.

## Core idea: two streams, not one

| Stream | Source | Who is on it |
|---|---|---|
| `mic` | default input device (AVAudioEngine, as today) | you (plus echo if on speakers) |
| `system` | Core Audio **process tap** on the call app (macOS 14.2+, `AudioHardwareCreateProcessTap` + aggregate device) | everyone else, mixed |

"Me vs others" comes from the channel. The voiceprint is a second check, and
diarization only has to split the `system` stream.

## Phase 0 — spikes (½–1 day, throwaway)

Answer the risky questions before building:

1. **Process tap from a spawned helper.** Tap Zoom / Teams / Chrome output
   from a CLI binary launched by Electron. Confirm which process macOS
   attributes the "System Audio Recording" permission to (expected: the
   Electron app as responsible process) and what the denial looks like.
2. **Which process to tap.** Teams and Chrome play audio from helper
   processes. Find by bundle id and include children, or fall back to a
   global tap that excludes Jarvis's own TTS (`jarvis-voice`) process.
3. **Echo on speakers.** Record mic on laptop speakers during a call; measure
   how much remote speech leaks. Try `inputNode.setVoiceProcessingEnabled(true)`
   (Apple AEC) and check it doesn't wreck Parakeet accuracy.
4. **Diarization budget.** Run `OfflineDiarizerManager` on a 60-min recorded
   call; note wall time and memory on this machine.

Exit: a short note in this file with the answers.

### Phase 0 findings (2026-10-25, macOS 26.6, M-series, built-in speakers)

Spike: `apps/audio-parakeet/spikes/tap-spike.swift` (`list`, `record`,
`analyze`). Build with `SDKROOT=…/MacOSX26.5.sdk` (CLT 27 SDK needs Swift 6.4).

1. **Process taps work from a CLI helper, but only inside an app bundle that
   declares `NSAudioCaptureUsageDescription`.** Run as a bare binary from a
   shell, the tap, aggregate device and IOProc all succeed and deliver
   **all-zero audio with no error, no prompt, no TCC log line**. The
   responsible process (here Claude desktop, in production our Electron app)
   lacked the usage string, so macOS denied silently. Wrapped in
   `TapSpike.app` (usage strings + ad-hoc signature) and launched via
   `open`, macOS prompted once and real audio flowed.
   → Jarvis's Electron `Info.plist` must carry `NSAudioCaptureUsageDescription`
   (and `NSMicrophoneUsageDescription`); dev runs from a terminal inherit the
   terminal's permission instead. **Detect denial as "all zeros while the
   tapped app reports `IsRunningOutput`"**, there is no error to catch.
   Grant persisted across rebuilds (keyed on bundle id).
2. **Audio played while the prompt is open is lost**; first meeting should
   be preceded by a permission check (a 1 s test tap) in onboarding.
3. **Tap is pre-volume.** System output was muted at volume 0 and the tap
   still captured full-level audio (peak −0.1 dBFS). Parakeet transcribed
   the tapped audio exactly. Meeting capture does not depend on speaker
   volume or headphones.
4. **Which processes:** Teams registers `com.microsoft.teams2` +
   `com.microsoft.teams2.helper` (×2); Chrome `com.google.Chrome` +
   `.helper` (×2). Tap by **bundle-id prefix**, collecting all matching
   process objects (re-scan when new helpers appear).
5. **An idle tapped process delivers no IO callbacks at all** (0 s, not
   silence). Phase 1 must timestamp by host time and pad gaps with silence
   so `mic.wav` and `system.wav` stay aligned.
6. Tap format here: 48 kHz stereo float32 interleaved; resampling to 16 kHz
   mono via `AVAudioConverter` works as in the existing helper.
7. **Echo on built-in speakers is a real problem.** Speakers at 31%,
   nobody talking, built-in mic, no processing (2 runs):
   echo lag 47–54 ms, coupling −35…−41 dB, mic 4–13 dB louder while the
   speakers play than in silence, and **Parakeet transcribed the echo on the
   mic almost word-for-word**. Without echo handling every remote sentence
   would appear twice, once labelled "You".
8. **Apple voice processing (`setVoiceProcessingEnabled`) is not usable here.**
   - The input format becomes 9 channels, deinterleaved; take channel 0, or
     the downmix comes out all zeros.
   - **It stops the process tap.** With VP on, the tap's aggregate device
     received zero IO callbacks in 2 of 2 runs, whether the tap started
     before or after VP. Without VP the tap worked every time.
   - VP's mic output was continuous noise at −30…−40 dB, with no
     intelligible speech (empty transcript). It only cancels audio played
     through its own unit, not another app's output.
9. **Plan change for Phase 1 echo handling.** We already have the exact
   far-end signal (the tap), so use reference-based cancellation instead of
   VP, cheapest first:
   - a. **Headphones:** detect the output device transport (built-in vs
     Bluetooth/USB/wired) and skip echo handling when the speakers aren't
     in use.
   - b. **Gate:** drop mic frames where the system stream is voiced and the
     mic level is within the expected echo level (system level −35 dB,
     ~50 ms later). Cheap, but it also clips you when you talk over someone.
   - c. **Text dedupe:** drop a mic segment whose transcript largely
     matches a `system` segment overlapping it in time.
   - d. **Real AEC:** WebRTC AEC3 (`webrtc-audio-processing`) or speexdsp
     echo canceller, fed with the tap as far-end reference and ~50 ms
     delay. The robust option, at the cost of a C/C++ dependency. Spike it
     at the start of Phase 1.
   - Phase 2 voiceprint check catches what slips through (echo isn't your
     voice).
10. **Dev friction:** with no code-signing identity on this machine, every
    rebuild gets a new ad-hoc signature and the **microphone** permission
    resets and prompts again. The audio-capture grant did not reset. A
    stable signing identity for the Electron app (and helpers) avoids this
    for users.
11. One intermittent run with two queued `--play` files got no tap audio;
    it didn't reproduce with single files (spike-only harness issue, not
    investigated).
12. Diarization budget (60-min call): _not run yet._ Teams/Chrome tap
    started before playback begins: _not run yet_ (needs a test call).

## Phase 1 — dual-stream capture + live transcript (You / Them)

**Helper: new long-running mode `parakeet --meeting <dir>`.**

- Opens both streams, resamples each to 16 kHz mono.
- Runs a separate `Listener` (existing VAD + partial/commit logic) per stream.
  Refactor: `Listener` gets a `stream` label and a `onFinal` callback instead
  of calling `exit(0)` in `commit()`; one-shot mode keeps exiting.
- Writes raw audio to `<dir>/mic.wav` and `<dir>/system.wav` (needed later
  for diarization, clips and re-processing). Stream-time offsets from one
  shared clock so both files line up.
- Mic echo handling per Phase 0 finding 9: skip on headphones; otherwise
  reference-based AEC (WebRTC AEC3 / speexdsp) using the tap as far-end,
  with gate + text dedupe as fallback. Not Apple voice processing (it
  stops the tap).
- Stops on SIGTERM or a `stop` line on stdin; flushes WAVs, emits
  `status stopped`.

**Protocol additions** (`protocol.md`):

```json
{"kind":"segment","stream":"mic","id":"…","start":12.40,"end":15.10,"text":"…"}
{"kind":"partial","stream":"system","id":"…","text":"…","revision":3}
{"kind":"status","state":"system-audio-denied","note":"…"}
{"kind":"status","state":"stopped","note":"<dir>"}
```

`segment` is a final with timestamps; `final` stays one-shot only.

**Main: `apps/main/src/meeting.js`.**

- `startMeeting({ app })` / `stopMeeting()`; owns the long-running child,
  mutually exclusive with `listenOnce` and the voice loop (reuse the
  `isListening` guard; TTS muted during a meeting).
- Store per meeting: `~/.config/jarvis/meetings/<yyyy-mm-dd-hhmm>/`
  with `mic.wav`, `system.wav`, `transcript.jsonl` (one segment per line),
  `meta.json` (app, start/end, status).
- Label: `mic` → "You", `system` → "Them".
- IPC: `meeting.start`, `meeting.stop`, `meeting.list`, `meeting.get`;
  events `meeting.segment`, `meeting.partial`, `meeting.status`.

**Deck:** Meeting toggle next to Mic/Voice, app picker (Zoom / Teams /
Browser / WhatsApp / All system audio), live two-colour transcript, a
clear "recording" indicator.

**Proof / tests**

- `parakeet --meeting --replay-mic a.wav --replay-system b.wav` streams two
  files through the live path (mirrors `--replay`).
- `scripts/prove-meeting.mjs`: two synthetic files from `voice-samples/`,
  assert interleaved You/Them segments with sane timestamps.
- `tests/unit/meeting.test.mjs`: segment parsing, store layout, guards
  (cannot start meeting while listening, stop is idempotent).

Done when: a real 10-min Zoom call gives a transcript with correct
You/Them labels and both WAVs on disk.

## Phase 2 — voice enrollment (your profile)

**Helper: `parakeet --enroll <out.json>`** (and `--embed <wav>` for tests).

- Records ~20 s of mic speech while you read 3–4 prompted sentences
  (deck shows them; varied phonemes, normal speaking pace).
- Rejects too-quiet / too-short / clipped takes with a status note.
- Splits voiced audio into ~4 s windows, `extractEmbedding` on each, keeps
  all raw embeddings plus their L2-normalised mean.
- Writes a `Speaker` (`id: "me"`, `name` from settings, `isPermanent: true`).

**Voice store:** `~/.config/jarvis/voices/`

- `people.json` — `[{ id, name, createdAt, updatedAt, embeddings: [[256 floats]…], sources: ["enroll","meeting:<id>"] }]`
- File mode `0600`; never sent anywhere, never put in brain context.
- Main module `apps/main/src/voices.js`: load/save, `addEmbeddings`,
  `rename`, `forget(id)` (hard delete). IPC `voices.list`, `voices.enroll`,
  `voices.forget`.

**Use in Phase 1 output:** mic segments are scored against "me"
(cosine distance via the stored embeddings). Low score → mark
`speaker: "unknown"` (someone sitting next to you, or echo that slipped
through). This is also the self-test for enrollment quality.

**Deck:** "Teach Jarvis my voice" flow in settings: prompt text, level
meter, retry, "test it" button (speak, show match score).

**Proof / tests:** enroll from one `voice-samples/` voice, assert another
clip of the same voice matches and a different voice doesn't.

Done when: after enrolling, your mic segments match "me" and a second
person talking into the mic is flagged unknown.

## Phase 3 — diarize the other side

- On `stopMeeting`, run `parakeet --diarize <dir>`: `OfflineDiarizerManager`
  on `system.wav` (batch is more accurate than streaming, and the meeting is
  over anyway). Optional later: streaming `DiarizerManager` for live labels.
- Assign each `system` transcript segment to the diarized speaker with the
  largest time overlap; split segments that span a speaker change by
  re-transcribing the sub-ranges.
- Per cluster: mean embedding + top 3 clean clips (longest non-overlapped
  speech) written to `<dir>/speakers/<cluster>.wav`.
- Match clusters against `people.json` (threshold from Phase 0 data, start
  at cosine distance ~0.35). Confident → name; close → `name?`; else
  `Speaker A/B/C`.
- Output `transcript.final.jsonl`; live transcript stays as the raw record.

Done when: a 3-person call yields You + two distinct remote speakers with
<10% of speech mis-assigned on a hand-checked sample.

## Phase 4 — name people after the meeting, remember them

- Deck "Who was this?" card per unknown/uncertain cluster: play clip,
  name field with autocomplete from `people.json` and calendar attendees
  (Google Calendar connector) of the event at that time.
- Naming an existing person adds the cluster's embeddings to them (capped,
  oldest pruned) — profiles get better and cover Teams vs WhatsApp codecs.
- Merge / split / rename / forget in a People view.
- Re-label the transcript immediately; past meetings can be re-labelled
  from their stored embeddings.

Done when: second meeting with the same people labels them by name with no
prompts.

## Phase 5 — discuss and act

- Meeting becomes brain context on request: "Jarvis, let's go over the
  standup." Long transcripts: send a structured summary (decisions, action
  items with owner, open questions, timestamps) plus retrieval over the full
  transcript, not the whole text every turn.
- Proposed actions (Linear issues, Slack follow-ups, calendar holds, email
  drafts) go through the existing decision inbox and autonomy policy —
  nothing sent without approval.
- Morning brief can list yesterday's meetings and open action items.

## Phase 6 — polish (optional)

- Auto-detect a call: watch `kAudioDevicePropertyDeviceIsRunningSomewhere`
  plus a known call app frontmost; offer "Start meeting mode?" (never
  auto-record).
- Retention setting (delete WAVs after N days, keep transcript).
- Live diarized labels via streaming `DiarizerManager`.

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| System audio permission from a spawned helper | Phase 0 spike first; clear `system-audio-denied` status and a deck hint |
| Echo on laptop speakers | Channel-overlap guard, Apple AEC, voiceprint check; recommend headphones |
| Codec differences across apps | Multiple embeddings per person, grown from each named meeting |
| Overlapping speech / short replies | Offline VBx, overlap exclusion, `name?` for low confidence |
| Long meetings (memory, CPU) | Stream to WAV on disk, diarize from file (memory-mapped) |
| Consent / recording law | Visible indicator; deck reminder to tell participants; local-only storage, `forget` deletes voiceprints |
| Apple Silicon only | Same as Parakeet today; sim covers CI |

## Order and rough size

| Phase | Size | Depends on |
|---|---|---|
| 0 Spikes | ½–1 d | — |
| 1 Dual-stream capture | 3–4 d | 0 |
| 2 Enrollment | 2 d | can start beside 1 (separate helper mode) |
| 3 Diarization | 2–3 d | 1, 2 |
| 4 Naming / memory | 2 d | 3 |
| 5 Discuss / act | 2–3 d | 1 (better with 4) |
| 6 Polish | as wanted | — |
