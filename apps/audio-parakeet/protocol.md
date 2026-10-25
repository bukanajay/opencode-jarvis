# Audio helper protocol (engine-agnostic)

Both helpers — `speech-analyzer` (Intel, `SFSpeechRecognizer`) and `parakeet`
(M5, Parakeet TDT 0.6B v3 via FluidAudio) — speak this on stdout, one JSON object
per line. The deck never learns which engine heard it.

```json
{"kind":"partial","id":"...","text":"...","revision":1}
{"kind":"final","id":"...","text":"..."}
{"kind":"status","state":"listening","note":"..."}
```

- `partial`: live caption. The composer **replaces** its caption, never appends.
- `final`: end of utterance. Main commits it as an `Utterance`
  (`source: "speech"`, `engine: "speech-analyzer" | "parakeet-v3"`) through the
  same path as typed text.
- `status`: terminal states are `mic-denied`, `speech-denied`, `unavailable`,
  `mic-error`. `listening` is informational.

Modes every helper implements (no mic needed):

- `--simulate "some sentence"`: progressive partials, then final.
- `--stdin`: each line is a partial, a blank line commits the final.

Parakeet-only modes (real model, no mic):

- `--file path`: transcribe an audio file, emit one final.
- `--replay path`: stream a file through the live VAD/partial/commit path.
- `--prepare`: download + compile the models, emit `status ready`, exit.

## Meeting mode (parakeet only)

`parakeet --meeting DIR [--app BUNDLE_PREFIX ...] [--no-mic]` runs until a
`stop` line or EOF on stdin (or SIGTERM). Two streams: `mic` (you) and
`system` (a Core Audio process tap on the call app, or all output without
`--app`). Writes `DIR/mic.wav` and `DIR/system.wav`, 16 kHz mono on one clock.
`--replay-mic A --replay-system B` streams two files instead (proofs; ignores
stdin EOF).

```json
{"kind":"status","state":"listening","note":"…","route":"speakers"}
{"kind":"partial","stream":"system","id":"…","text":"…","revision":2}
{"kind":"segment","stream":"mic","id":"…","start":3.86,"end":10.78,"text":"…",
 "micDb":-23.3,"micVoiced":0.85,"systemDb":-14.2,"systemVoiced":0.84}
{"kind":"status","state":"system-audio-denied","note":"…"}
{"kind":"status","state":"stopped","note":"DIR","seconds":14.6}
```

- `segment`: one committed utterance, seconds since start; levels are the
  median dBFS and voiced share of *both* streams over the segment, which
  Main uses to spot speaker echo on the mic.
- `route`: default output (`speakers`, `headphones`, `bluetooth`, `usb`,
  `display`, `other`).
- `system-audio-denied` is not fatal: the tapped app reports output but the
  tap hears exact zeros (macOS denies silently).
- Live meeting mode re-execs itself with responsibility disclaimed, so macOS
  asks for System Audio Recording and Microphone on behalf of parakeet
  (its embedded `Info.plist`), whoever launched it.

Audio never leaves the box. Only text crosses into Main.
