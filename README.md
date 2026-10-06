# Jarvis — Step 1 Loop

Exit: typed prompt returns streamed reply without the official desktop open.

## What was proven (2026-10-06, Intel x86_64)

`node scripts/prove-server.mjs` against the shared local service:

* `Service.ensure()` -> `http://127.0.0.1:49374`, `server=2.0.24`
* session create with `{ agent: "build", model: { providerID, id } }`
* `session.prompt({ sessionID, text })` — no `model` field on prompt in client 2.0.24
* events are `{ type, data: { sessionID, ... } }`, not `properties`
* text streams on `session.text.delta` (`data.delta`), done on `session.execution.succeeded/failed`

Result: `loop-ok` on `opencode/fledge-alpha-free`.

## Luna status

Wanted default is `opencode-go/gpt-6-luna`. Currently `provider.quota: Go usage limit exceeded (5 hour)`.
`apps/main/src/sessions.js` keeps Luna as default, falls back once, and reports
`modelUsed` so Jarvis can say which model actually answered.

Set `JARVIS_MODEL=provider/id` to override without code change.

## Run

```sh
npm install
node scripts/prove-server.mjs "Reply with exactly: loop-ok"
npm --workspace apps/main run dev   # Electron deck, same Service.ensure() path
```

## Contracts (locked)

See `packages/proto/types.ts`, `packages/proto/allowlist.json`, `plugins/jarvis/rpc.ts`.

Next: Step 2 Voice (SpeechAnalyzer helper -> same `Utterance` type).

## Step 2 Voice (done 2026-10-06)

`npm run build:audio && node scripts/prove-voice.mjs` -> `voice-ok`.

* `apps/audio-speech-analyzer/src/helper.swift` (compiled with `swiftc`): owns the mic
  via `SFSpeechRecognizer` (on-device when supported) + `AVAudioEngine`. Stdout protocol:
  `partial` / `final` / `status`. `--simulate` and `--stdin` modes for proving
  plumbing without mic permission. No network audio; text only leaves the box.
* `apps/main/src/audio.js`: spawns one utterance at a time, forwards partials as
  `caption.partial`, commits `final` to `Utterance{source:speech, engine:speech-analyzer}`.
* `utterance.commit` (typed) and `audio.start` (speech) converge on the same
  `promptJarvis` call. Proven: `shape-ok` + live `voice-ok` reply.
* Deck: Mic button, caption line in composer replaces itself per partial
  (`apps/deck/index.html`), never appends. Live region is text, not canvas.

## Step 3 Fleet (done 2026-10-06)

`WORKER_MODEL=opencode/fledge-alpha-free npm run prove:fleet` -> `fleet-ok`.

* `apps/main/src/fleet.js`: child sessions (`parentID` = Jarvis session), one shared
  event pump with listener set, per-worker `idle|working|permission|done|failed|stopped`,
  transcript + tool trace. Tool state from `session.tool.*`; done on
  `session.execution.succeeded/failed`.
* Permission gate is a blocking card, not a toast. `permission.asked` breaks the
  ring into the center + permission sound; `Allow once`/`Deny` by hand, or spoken
  `allow`/`deny` — `routeUtterance` sends controls to `permission.reply`
  (`once`/`reject`, never silent `always`) and everything else to Jarvis.
  Proven live: `/tmp` write asked `external_directory`, deny won, file absent.
  Idle external gates auto-resolve fast, so replies go out inside the event
  handler; the deck hides the card on `permission.resolved`.
* Stop = `session.interrupt`, delete = `session.remove`. Proven: worker stopped
  mid-`sleep 30`, deleted, gone from `session.list`.
* Deck: DOM ring (center Jarvis, workers on ring), work view per worker
  (transcript + tool trace), three WebAudio sounds (permission/done/fault).
  `WORKER_MODEL` env selects the worker model; Luna stays the Jarvis default.
