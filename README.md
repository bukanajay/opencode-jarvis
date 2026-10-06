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

Wanted default is `opencode-go/gpt-6-luna`. The Go 5-hour quota blocked it on
2026-10-06 afternoon, so `apps/main/src/sessions.js` keeps Luna as default, falls
back once, and reports `modelUsed` so Jarvis can say which model actually answered.
Recheck 2026-10-06 ~18:30 local: Luna live (step runs `opencode-go/gpt-6-luna`,
first text at ~1s, `loop-ok` on the default path). Fallback stays for the next
quota window.

Set `JARVIS_MODEL=provider/id` to override without code change.

## Run

```sh
npm install
node scripts/prove-server.mjs "Reply with exactly: loop-ok"
npm --workspace apps/main run dev   # Electron deck, same Service.ensure() path
```

## Contracts (locked)

See `packages/proto/types.ts`, `packages/proto/allowlist.json`, `plugins/jarvis/rpc.ts`.

Steps 1–7, including Voice, are complete; remaining implementation and
hardware-validation work is listed in `ROADMAP.md`.

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

## Step 4 Shell by voice (done 2026-10-06)

`node scripts/prove-shell.mjs` -> `shell-ok`. No model calls.

* `apps/main/src/shell.js`: app-owned store (`~/.config/jarvis/shell.json`,
  `JARVIS_SHELL_FILE` override), allowlist `set.accent|density|layout|captionSize|
  audioDevice|wake`, value enums, audit entries `{bucket: shell, live: true}`.
* `matchAppCommand` is exact and enumerable — 10 phrases incl. `use the amber accent`,
  `set the theme to amber` (theme is the accent alias), and `dim the fleet`
  (→ `set.accent dim`). Widening (`let every agent run any shell command`),
  model work, and unknown accents never match.
* `routeUtterance` checks app commands before the model path, after the pending
  permission gate. One stale fleet assertion updated: `dim the fleet` is now
  `app.command` even mid-gate, by spec.
* Exit proven: amber applied synchronously (`apply-ok`), same file re-read by a
  fresh store (`persist-ok`), unknown values and non-allowlisted commands rejected
  (`validate-ok`). Deck paints `--accent`/`captionSize` on `settings.applied` and
  keeps the audit log as the settings surface.

## Step 5 Config by voice (done 2026-10-06)

`npm run prove:config` -> `config-ok` (route, write+reload+confirm, dispatch, read-only, widen, discard, cleanup).

* `apps/main/src/config.js`: server-config bucket. `add a read-only reviewer`
  writes `.opencode/agents/reviewer.md` (watched file, `edit`+`bash` deny) and reads
  `agent.list`/`get` back before reporting — proven `mode subagent, edit deny`,
  reload visible in ~20ms. Removal is verified the same way.
* Exit proven: the reviewer dispatched a real review (`dispatch-ok`), and an explicit
  edit instruction produced no file (`readonly-ok`).
* Widening is a stage + second confirm, never silent. `let every agent run any shell
  command` stages the exact rule `{shell * allow}` on a blocking card; `yes, apply
  it` applies via saved permission (`effect: allow` returned), `no` discards —
  proven the discarded session-delete left its worker alive. Voice `allow`/`deny`
  still belong to the permission gate; config confirms use `yes`/`no`.
* Model note: free-tier `opencode/*` models reject direct subagent sessions
  (403 `FreeTierError`), so reviewer dispatches ride `openrouter/apodex`
  (`REVIEWER_MODEL` override) until Luna quota returns. Luna stays the Jarvis default.

## Step 6 Parity (done 2026-10-06, surface by surface, same server as desktop)

* Sessions (`prove:sessions`): rename reflected in `session.get`, fork returns a live
  id, delete removes both. Work-view Rename/Fork buttons.
* Forms (`prove:forms`): the server emits no creation event, so the gate detects via
  the question-tool call + re-list. Blocking card by hand, spoken option text answers
  single-field forms (`matchFormAnswer` pure + live). Out: nothing — session sharing
  and TUI themes/keybinds stay out per spec (unsupported / `cli.json` only).
* Agent/model switch (`prove:switch`): next `step.started` runs the new agent+model.
  Luna asserted as Jarvis default. Work-view selects.
* Commands/skills/attachments (`prove:cmdskill`): 29 commands, 71 skills cataloged;
  live `/review` turn; attached file quoted back. Composer datalist + attach path;
  `/name` and `@skill` route off the model path.
* Diff/undo/redo (`prove:diff`): rollback boundary is the **user** message (assistant
  messages stage empty). Undo restores files + cleans diff; redo = pre-undo fork.
  Work-view Diff/Undo buttons.
* Terminal/PTY (`prove:terminal` + `prove:pty-live`): shell run/poll/kill
  (one-shot Yard path); PTY open/resize/close plus live frames over a
  websocket ticket minted in main (`x-opencode-ticket: 1` ->
  `GET /api/pty/:id/connect?ticket=`). Outbound frames are raw UTF-8 chunks
  plus one `0x00`+`{"cursor"}` meta frame; inbound text frames are stdin.
  Yard has both paths labeled: one-shot shell vs live PTY (stream, write,
  reconnect with cursor resume, resize, close). Tickets are single-use, so
  every (re)connect mints a fresh one.
* MCP (`prove:mcp`): atlassian connected; GitLab OAuth attempt issued a real authorize
  URL, polled pending, cancelled. Deck status section.
* Worktrees/project/compact (`prove:workproj`): worktree field mapping
  (`from`=source dir, `branch`=base, `name`=new, `directory`=root) create-list-remove
  with branch cleanup; external-directory worker; session answers after compact.
  Yard project spawn + worktree list, work-view Compact.

## Step 7 M5 audio (done on Intel 2026-10-06, M5 swap is a binary drop-in)

`npm run prove:audio` -> `audio-ok`.

* Contract first: `apps/audio-parakeet/protocol.md` locks the JSON-lines protocol
  (`partial`/`final`/`status`, `--simulate`, `--stdin`). Both helpers speak it;
  the deck never learns the engine.
* `apps/audio-parakeet/src/sim.swift` (pure Foundation) compiles anywhere and is
  protocol-identical to the Intel helper. `src/helper.swift` is the M5 live path:
  Parakeet TDT 0.6B v3 via FluidAudio (`AsrModels.downloadAndLoad(version: .v3)`,
  `AsrManager`, ANE), same protocol out. `Package.swift` pins the FluidAudio dep.
* `apps/main/src/audio.js`: `JARVIS_AUDIO_ENGINE` selects `speech-analyzer`
  (default) or `parakeet`; unknown engines rejected. `Utterance.engine` is
  `speech-analyzer` or `parakeet-v3`, everything else identical — proven same keys,
  same routing, no model involved.
* M5 setup: `swift build -c release && cp .build/release/parakeet bin/parakeet`
  (first run downloads the CoreML model once), grant Microphone, set
  `JARVIS_AUDIO_ENGINE=parakeet`. Verify on M5 with `npm run prove:audio` plus one
  live mic utterance. Open tuning items live in `helper.swift` (16 kHz resample,
  VAD-gated windows) — verify, don't trust.

## Brain (core done 2026-10-06; voice + fleet-bootstrap + auto done same day, see below)

`npm run prove:brain` -> `brain-ok` (memory, model, turn, persist).

* `apps/main/src/brain/memory.js`: local long-term memory
  (`~/.config/jarvis/memory.json`, `JARVIS_MEMORY_FILE` override). Facts with
  local-embedding recall first (MiniLM) and BM25 fallback; extraction stays
  heuristic (`remember…`, `my X is Y`, `I prefer…`) — LLM extraction is the
  remaining later slice.
* `apps/main/src/brain/brain.js`: LangGraph (`@langchain/langgraph`)
  recall → think → persist. Think reasons through an OpenCode session, so Luna
  stays the default and switching is validated against the OpenCode model list
  (`JARVIS_BRAIN_MODEL` or `setBrainModel`), no new provider keys. Quota fallback
  preserved. The deck prompt path now runs through the graph with a direct-turn
  fallback if the graph throws.
* Pending (tracked in ROADMAP.md, not forgotten): LLM fact extraction for
  memory (heuristic regex only today), M5 live-mic verification (16 kHz/VAD
  tuning unverified).

## Voice, bootstrap, auto (done 2026-10-06, three parallel slices + integration)

`prove-voice-mode` (18 checks), `prove-bootstrap`, `prove-autoroute`,
`prove-integration` -> all green.

* Voice (`apps/main/src/voice.js`): pure wake gate — `hey/ok jarvis` detected and
  stripped, off-mode blocks everything, stripped text reuses `commitText` so
  `hey jarvis, dim the fleet` applies with no model. Main runs the mic loop only
  while `set.voiceMode on`; push-to-talk suspends it via `isListening` guard.
  Deck has a Voice toggle next to Mic.
* Bootstrap (`apps/main/src/bootstrap.js`): `fleet.spawn` with no agent on an
  empty fleet opens a staged gate (purpose → provider → model → effort →
  confirm showing the exact spec) instead of spawning. Confirm writes the agent
  file, verifies via `agent.get`, then resumes the stashed task on the new agent.
  Deck blocking card with option chips.
* Auto (`apps/main/src/autoroute.js`): `@id`/`ask id to`/`using id` explicit forms
  validated against registry + builtins; auto on picks by keyword overlap with
  visible reason (`review->reviewer (3 hits)`), ties/empty fall back to
  `set.defaultAgent` (default `build`). Deck agent select preselects the default.
* Kept decisions: new-agent permissions default to ask (the gate arbitrates each
  edit/shell call instead of silent allow); `@build` stays valid explicit;
  bootstrap `yes` loses ties to permission/config confirms by existing route order.
* Recall is local-embedding first (Transformers.js MiniLM, ONNX CPU, no keys;
  model downloads once then runs offline), BM25-lite fallback
  (`JARVIS_EMBED_OFF=1` forces it). Paraphrase with zero shared keywords recalls
  (`boat name` → `ship called Aurora`, 0.52 vs 0.01 unrelated); unrelated stays
  empty via a 0.28 floor. Vectors persist beside facts in `memory.json`.
  Embedder warms in the background at boot. Voice loop backs off (1.5s → 30s
  cap) on repeated mic failures instead of hot-looping.

## Brain act (done 2026-10-06)

`npm run prove:act` -> `brain-act-ok` (parse, stream filter, prompt, plain turn,
canned chain, live Luna delegation).

* Think emits single-line ` ```dispatch {"task", "agent?"}``` ` fences; the act
  node parses and strips them. Only exact-shape JSON executes — extra keys, bad
  ids, empty/multiline tasks, and braceless fences warn and never run.
* A line-buffered stream filter holds fences back mid-flight, so the transcript
  stays readable while staying live.
* `dispatchTask` in main runs every intent through autoroute (explicit → auto →
  default) and the bootstrap gate, then spawns; deck logs each outcome. Both the
  deck spawn button and brain dispatches share it.
* Proven live: Luna fenced, the fence resolved, the worker ran and was deleted.
  Prompt carries MUST-delegate language plus the live fleet registry (or the
  no-fleet line when empty). One retry absorbs a sampling miss.
* Real find: millisecond `Date.now()` fact ids collided on rapid remembers,
  silently dropping vectors and flaking recall. Ids are now unique, loads dedupe,
  sub-floor tail scores are filtered.

## Settings models (done 2026-10-06)

`npm run prove:models` -> `models-ok` (validate, precedence, live switch).

* Luna stays the Jarvis default, now changeable in the drawer Models panel:
  Jarvis / Fleet / Default-agent selects fed by the server lists, applied through
  `app.command`. `set.jarvisModel` validates against the model list and switches
  the live brain session *before* saving — a bad model never persists.
* Precedence everywhere: env > shell > default (`JARVIS_BRAIN_MODEL`,
  `WORKER_MODEL` still win for scripts and tests).
