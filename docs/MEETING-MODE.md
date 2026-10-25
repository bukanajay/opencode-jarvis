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

### Phase 1 status (2026-10-25)

Built: `parakeet --meeting` (`src/meeting.swift`; `helper.swift` became
`main.swift` so the target can have two files), `apps/main/src/meeting.js`,
IPC `meeting.start|stop|state|list|get` + `meeting.event`, deck Meeting
button and live panel, `tests/unit/meeting.test.mjs`,
`npm run prove:meeting` (real model, You/Them/You, echo at −30 and −12 dB).

What changed from the plan:

- **Permission, solved for every launcher.** Live meeting mode re-execs
  itself with `responsibility_spawnattrs_setdisclaim`, and the binary
  carries its own `Info.plist` (`apps/audio-parakeet/Info.plist`, linked into
  `__TEXT,__info_plist`, signed `-i dev.jarvis.parakeet`). macOS then asks
  for System Audio Recording and Microphone *for parakeet*, whether Jarvis
  runs from a terminal, the LaunchAgent or a packaged app. Verified from a
  plain shell (which got silent zeros in Phase 0).
- **Parakeet fails on hot audio.** Tapped call audio peaks near 0 dBFS; for
  whole utterances Parakeet then returned an empty string or different
  words, depending on exactly where the clip was cut (10/10 failing clips
  fixed by −12 dB). `padded()` now scales any clip that peaks above −10 dBFS
  to a −10 dBFS peak (all modes; mic speech is quieter and passes untouched).
- **Echo handling (Phase 0 finding 9), first cut in Main:** text dedupe
  (≥60% of a mic segment's words said on the system stream within ±1.5 s)
  and a level rule (call playing ≥60% of the segment, mic ≥25 dB quieter,
  not on headphones/bluetooth). Live on built-in speakers at ~50% the echo
  reached the mic only ~9 dB below the call and transcribed verbatim, so the
  level rule alone would miss it; the text rule caught it. Echo segments
  stay in `segments.jsonl` (flagged) and drop out of `transcript.jsonl`.
  Real AEC is still open (only needed if your own speech gets lost when you
  talk over someone, the text rule can't separate that).
- **The system stream's VAD never fired live.** A process tap hands over
  ~10 ms per callback, less than one 20 ms VAD frame, and the VAD only
  looked at whole frames inside each chunk, so the call side produced no
  segments at all (replay fed 100 ms chunks and hid it). The VAD now walks
  the listener's buffer across chunk boundaries (one-shot mode was also
  skipping ~6% of mic frames this way), and replay feeds the system track in
  10 ms pieces so `prove:meeting` covers it.
- **Grants survive rebuilds.** The default ad-hoc designated requirement is
  the code hash, so every rebuild lost the Microphone grant (and a grant
  switched on in Settings for an older build reads as *denied*). Signed with
  `-r='designated => identifier "dev.jarvis.parakeet"'`.
- **Live, verified (built-in speakers ~50%, global tap, nobody talking):**
  `Them` gets the call's sentence, the mic's verbatim echo copy (60 ms later,
  ~10 dB below the call) is hidden by the text rule, transcript has one line.
  Mic trails system by 28–46 ms across runs: the shared clock holds.
- **"All system audio" hears everything playing on the Mac.** Another app's
  audio running straight into the call's speech became one utterance that
  Parakeet garbled (each half alone transcribes fine). The deck defaults to
  All (works with any call app) and remembers the last pick; tapping the
  call app is the cleaner choice.
- **Not yet handled:** short noise after speech sometimes becomes one or two
  invented foreign words ("jedinę", "Ich gehe"). Candidates: drop segments
  under ~1 s with a low voiced share, or a language hint once FluidAudio
  exposes one.
- **First real call (2026-10-25, 8 min, Teams-style call, all system
  audio, built-in speakers, two people).** 34 segments; speaker labels
  right throughout; the other person's long answers transcribed cleanly;
  3 verbatim echo copies of their sentences hidden, none of yours. Found:
  - Stop in the deck was swallowed: Electron windows ignore the first click
    while another app (the call) is focused. Deck now `acceptFirstMouse`.
  - A one-word echo ("Who") slipped through (text rule needs ≥2 words).
    One-word segments now count as echo when the call said the same word
    within 0.5 s.
  - **Hindi / Hinglish is not transcribed.** Parakeet TDT v3 covers 25
    European languages; your code-switched lines came out as nonsense
    ("test curvath", "share karma"), and short unclear audio sometimes
    came back as Spanish/Russian ("Y lo que sí", "Ну"). English is solid.
    Fixed by the Whisper engine below.
  - Backchannels ("Mm-hmm", "Okay") from the other side while you talk are
    real and kept; transcript is ordered by start time, so they sit after
    your long turn begins.
- Not yet verified:
  tapping a single app (`--app`) whose helper process appears mid-call (the
  retarget path), and a 60-minute run
  (memory stays flat by design: listeners trim to the current utterance,
  WAVs stream to disk).

### Hindi + Hinglish engine (2026-10-25)

Per meeting, the deck offers **English** (Parakeet, default, fastest) or
**Hindi + Hinglish** (Whisper). Capture, VAD, echo handling and storage are
shared; only the transcriber differs (`src/whisper.swift`).

- **Model:** Oriserve Whisper-Hindi2Hinglish-Apex (Apache 2.0, large-v3-turbo
  fine-tuned on ~700 h of noisy Indian-accented Hindi; self-reported WER on
  Hindi ~40% lower than Whisper large-v3). Writes Hindi as **romanized
  Hinglish**, keeps English as English. GGML q8_0 (874 MB) from
  `Marquestra/Whisper-Hindi2Hinglish-Apex-GGML`, SHA-256 pinned:
  `npm run fetch:whisper-model` → `~/.config/jarvis/models/`.
- **Runtime:** whisper.cpp v1.9.5, static libs with Metal, linked into
  parakeet by `build-parakeet.sh` when cmake is available (otherwise the
  engine reports itself unavailable). Language token `hi`, greedy, no
  context between utterances, segments with no-speech probability > 0.6 or
  the literal `nan` dropped. Partials every 2.5 s.
- **Why not alternatives:** FluidAudio has no Indian-language ASR; plain
  Whisper turbo writes Hindi in Devanagari and is weak on code-switching;
  WhisperKit needs SwiftPM, which is broken on this machine.
- **On your real call (8 min, replayed):** your Hinglish is readable
  throughout ("Actually main kya kar raha hoon na… ek agent banaaya hai jo
  voice hamse baat kar paega…"); the other side's "Mm-hmm" / "Y lo que sí"
  became "Thik hai", "Ji ji", "Ok sir"; 41 s of audio transcribes in ~1.1 s
  warm. English is a little worse than Parakeet ("steps" for "specs",
  "section 2" for "too"), hence the per-meeting choice.
- **Fixed on the way:** ggml-metal asserts at `exit()` while a context holds
  buffers (meeting saved as *failed*): the context is freed after the last
  utterance. And meeting commits no longer block the VAD: whatever was said
  while an utterance was being transcribed (Whisper's first pass takes
  >1 s) was being dropped; the clip is now handed over and listening goes on
  at once. `prove:meeting` has a Hindi case (macOS voice Lekha) that caught it.
- **Open:** noise before a call can still come back as a one-word Devanagari
  line ("जाज"); an echo whose call-side copy Whisper mis-hears can slip past
  the text rule.

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

### Phase 2 status (2026-10-25)

Built: `src/voice.swift` (voiceprints: WeSpeaker v2 through FluidAudio's
`EmbeddingExtractor`, 10 s windows with an energy speech mask, averaged and
L2-normalised; `--embed` and `--enroll` modes), `apps/main/src/voices.js`
(people.json, 0600, no vectors leave Main), IPC `voices.list|record|stop|
forget` + `voices.level`, deck Settings → You → *Teach Jarvis my voice* /
*Test it* / *Forget my voice*, `tests/unit/voices.test.mjs`, and a
voiceprint case in `prove:meeting`.

- **Measured on the real call before building on it:** your own lines
  0.75–0.95 against each other; you vs your colleague 0.03–0.17; you vs the
  echo of their voice 0.03–0.13. Enrolling from two of your lines, your
  held-out lines scored 0.81–0.96 and everything else ≤0.16. Thresholds:
  ≥ 0.5 is you, < 0.35 is someone else, between is undecided. Clips with
  under ~1–2 s of speech give weak prints, so they get no score.
- **Enrollment:** ~30 s reading English + Hinglish prompts (how you talk in
  meetings); 5 s windows with ≥2 s of speech; needs ≥10 s of speech and a
  mean window-to-window similarity ≥0.6, or it is refused (noise or a
  second voice). Re-recording replaces the print. Audio is not kept.
- **In meetings** (`--voices` path passed by Main): every segment gets its
  voiceprint (kept in `segments.jsonl` for Phase 3/4, never in events or
  `transcript.jsonl`) and its score against each known voice. Mic lines:
  your voice is never hidden as echo, even when you repeat their words;
  not your voice while the call is playing is echo (`echo: "voice"`), and
  otherwise the line is labelled **Someone else**. Replaying the real call:
  the 6:38 echo that both word rules missed ("Okay. Which uh will be
  implemented…", you04) is now hidden by voice; none of your lines are.
- **Limit seen:** two near-identical synthetic voices (macOS Samantha vs
  Karen) scored 0.61, over the threshold; other voices, including another
  woman (Moira), scored 0.12–0.28. Real people on the call were far apart,
  but very similar voices (siblings?) may need a higher threshold or more
  enrollment audio.

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

### Phase 3 status (2026-10-25)

Built: `src/diarize.swift` (`parakeet --diarize DIR`), `diarizeMeeting` +
`assignSpeakers` in `meeting.js` (runs when a meeting stops, before the
transcript is written), `speakers.json` per meeting (voiceprints, for Phase
4) and `meta.speakers` (labels, seconds, clip), deck relabels the live
panel in place.

- **Not FluidAudio's offline diarizer.** On three clearly different voices
  taking turns (Daniel / Moira / Aman), it returned one speaker at any
  threshold, and told there were exactly three it still mixed two of them.
  The Phase 2 voiceprints scored ≥0.79 within each voice and ≤0.23 across,
  so diarization is built on them: 1.5 s windows every 0.5 s, chained into
  turns while consecutive windows stay alike (≥0.6), turns ≥2 s clustered by
  average linkage (merge ≥0.5), shorter turns joined to the voice they
  match (≥0.5) or their neighbour in time, voices under 2 s folded in and
  under 5 s joined to their closest voice at ≥0.3 (a hesitant "Uh, so…"
  start of a turn printed off and became its own speaker before that).
  Bonus: call-side speakers live in the same space as people.json.
- **Results:** the three-voice fixture splits perfectly (every line to the
  right speaker); your real call (one remote person) stays one speaker; the
  8-minute call side diarizes in ~1 s.
- **Labels:** a speaker matching a known voice (≥0.5) takes its name; two or
  more unknown voices become Speaker A, B, … by who spoke first; a single
  unknown voice stays "Them". Lines the turns do not cover (short
  backchannels) go by their own voiceprint, else the nearest turn ≤3 s.
- **Proof:** `prove:meeting` has a three-person call: You / Speaker A /
  Speaker B / Speaker C / Speaker A / You, all four echoes hidden by voice.
- **Open:** not yet on a real multi-person call; overlapping speech (two
  people at once) lands with whoever dominates the window; a segment that
  spans two speakers keeps one label (the one it overlaps most).

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

### Phase 4 status (2026-10-25)

Built: `rememberVoice` / `renameVoice` / `mergeVoices` / `bestVoice` in
`voices.js`; `speakersToName`, `nameSpeaker`, `identifySpeakers` and a
shared `applyDiarization` in `meeting.js`; IPC `meeting.speakers|clip|
nameSpeaker|nextToName`, `voices.rename|merge`; deck "Who was on this
call?" card (clip ▶, a line they said, name box with known people) shown
when a meeting with unknown voices stops, "Name voices from recent
meetings" and a "People Jarvis knows" list (rename, forget) in Settings → You.

- **Naming** stores the speaker's call voiceprint under the name: the same
  name twice builds one person (samples capped at 50, oldest dropped), your
  own voice cannot be named, merge joins two entries. This meeting is
  relabelled at once, and every other saved meeting where that voice is
  still unnamed is relabelled too; speakers you named stay named (renames
  carry through). Only voices you name or confirm add samples: automatic
  matches never feed the profile, so a wrong match cannot drift it.
- **Unsure matches** (0.35–0.5) read "Ravi?" and the card asks to confirm.
  Asked about: unknown or unsure voices with a clip and ≥3 s of speech.
- **Older meetings:** `identifySpeakers(id)` runs the Phase 3 split on a
  saved meeting (transcript rebuilt from `segments.jsonl`); the deck button
  does that for your last ten meetings and opens the card for the newest
  with voices left. Run on the first real call (2026-10-25-1756): one
  speaker, 29.5 s, clip saved, waiting for a name.
- **Proof (real models):** after naming the three-person panel (A → Daniel,
  B → Moira, C → Aman), a new meeting with the same voices in a new order
  comes out as Moira / Aman / You / Daniel with nothing left to ask.
- **Not done:** calendar attendees as name suggestions (the Calendar
  connector runs through the brain, not Main); naming "Someone else" lines
  from your own mic (they are not clustered yet); a split for a voice that
  turns out to be two people.

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
