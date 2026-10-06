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

Audio never leaves the box. Only text crosses into Main.
