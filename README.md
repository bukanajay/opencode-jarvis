# Jarvis

A sci-fi voice-and-text deck for OpenCode. Jarvis is a LangGraph agent with
long-term memory that talks to you in a chat transcript, sees a live fleet of
worker sessions on a ring, and delegates work to them — by voice or by typing.

Built on the OpenCode server (`@opencode/client` + `Service.ensure()`), so
Jarvis and the official desktop share one server, one session list, and one
config. No model keys needed: the default model is `opencode-go/gpt-6-luna`,
changeable in Settings.

## Quickstart

```sh
npm install
npm run build:audio      # Intel speech helper (SpeechAnalyzer) + parakeet sim
npm run build:parakeet   # Apple Silicon: Parakeet (ears) + jarvis-voice (Kokoro voice), one-time model downloads
npm --workspace apps/main run dev   # launch the deck
```

First launch opens a short **setup** where Jarvis asks, out loud, for your name, its brain model, the workers' default model and its voice; nothing is saved until you confirm, and the brain model is validated against the server first. Rerun it any time from Settings → You → *Run setup again* (or just say `call me <name>`).

Then type `hi`. Or press the mic and say `hey jarvis, dim the fleet`.

## How it works

Three processes, one command bus:

| Piece | Role |
| --- | --- |
| `apps/deck` | The deck. No Node, no OpenCode client — draws and sends intents over IPC. |
| `apps/main` | Owns `@opencode/client` and `Service.ensure()`. The only place that changes settings or writes config. |
| `apps/audio-*` | Native mic helper. Intel: Apple SpeechAnalyzer. Apple Silicon: Parakeet TDT 0.6B v3 via FluidAudio on the Neural Engine (picked automatically once built; `JARVIS_AUDIO_ENGINE` overrides). Emits partial captions + finished utterances. Audio never leaves the box. |

```
mic → helper → Utterance ─┐
textbox → Utterance ──────┴→ main → brain (Jarvis) or local control
server events → main → renderer
```

Main decides control-phrase vs model-prompt, so a flaky transcript can never eval anything.

## The brain

`apps/main/src/brain/` — a LangGraph loop (`recall → think → act → persist`)
with the OpenCode session as its reasoner:

- **Memory** — local long-term store: global (`~/.config/jarvis/memory.json`) plus per project (`remember for this project that …`); recall searches both, project facts first. Local-embedding first (MiniLM/ONNX, no keys, runs offline), BM25 fallback. Heuristic fact extraction.
- **Read-only** — the brain runs on the `plan` agent with edit/write/bash/task denied (`JARVIS_BRAIN_AGENT` to change). It reads the project itself to answer code questions; anything that changes or runs code is delegated. Stray permission asks are auto-rejected, never left hanging.
- **Act** — think emits single-line `dispatch {"task", "agent?"}` fences. Only exact-shape JSON executes; everything else is words. Every intent runs through autoroute + the bootstrap gate, then spawns.
- **Review loop** — when a worker finishes, Jarvis gets its final message, changed files and a diff excerpt, reviews the outcome in the chat, and takes at most one next step: a `followup {"task"}` to the same worker (e.g. "run the tests") or a new dispatch (e.g. a reviewer). Bounded to `JARVIS_MAX_ROUNDS` (3) per chain; `turn review mode off` disables it.
- **Model** — Luna default, switchable in Settings → Models (validated against the server list, live-switches before saving). `JARVIS_BRAIN_MODEL` env still wins for scripts.

## Voice

- Push-to-talk mic button, or **voice mode** (waveform icon): the mic stays open and `hey <wake>` dispatches hands-free through the same path as typed text.
- **Voice focus** — voice mode hides the transcript and gives the deck to the ring: a bigger orbit and Jarvis core, live captions and Jarvis's spoken line underneath. *Transcript* pins it back while you keep talking (*Hide* tucks it away again); *Voice off* restores the normal deck.
- **Spoken replies** — in voice mode Jarvis answers out loud with a one-or-two-sentence summary (a held-back `speak {"text"}` fence, or a local summary of the reply if the model omits it); the full answer stays in the transcript. The core ripples with the real loudness of the audio while it talks. Its own voice is ignored by the mic; say `hey jarvis …` to cut in, or `hey jarvis stop` to hush it.
- **Conversation** — say `hey jarvis` once, then just talk: follow-ups need no wake word while the conversation is open (held while Jarvis thinks or speaks, then Settings → Voice → *keep listening for*, default 30 s). `that's all` / `goodbye` ends it; `ok` / `thanks` keep it open without starting a turn.
- **One voice** — on Apple Silicon Jarvis speaks through `jarvis-voice`: Kokoro-82M, a neural voice rendered on device (~150 ms per line, model kept warm while voice mode is on). Default `bm_george` (British male); change it with `use the fable voice` / `set voice to am_michael` (Settings key `voice`, persisted). Every turn uses that one voice. Without the helper (Intel) the deck pins one system voice once the voice list has loaded, so it no longer drifts between turns.
- Shell phrases (`dim the fleet`, `use the amber accent`) apply locally with no model call. Permission answers (`allow`/`deny`) and worker controls (`stop the worker`) are exact-match controls (trailing `.`/`!`/`?` from the speech engine is ignored).
- **Parakeet (Apple Silicon)** — the helper opens the mic before the model loads, resamples to 16 kHz, gates on an adaptive energy VAD, re-transcribes the utterance every ~0.7 s for live captions and commits after ~0.9 s of silence. Noise that transcribes to nothing is dropped, not committed. Tunables (env, no rebuild): `JARVIS_PARAKEET_SILENCE_MS` (900), `JARVIS_PARAKEET_PARTIAL_MS` (700), `JARVIS_PARAKEET_MIN_SPEECH_MS` (250), `JARVIS_PARAKEET_MIN_RMS` (0.008), `JARVIS_PARAKEET_MAX_S` (30).

## What Jarvis does itself

Jarvis's brain is read-only: it reads the project, never edits it or runs commands (deny rules on its session; anything on the code or the machine goes to a worker, and a reply like "I can't access your shell" is turned into a worker task automatically). It still runs the deck: each turn it sees the live state (workers with ids/states/tasks, open worktree branches, pending approvals, settings, recent projects) and can act on it with a validated ```` ```jarvis {"action": …}``` ```` fence (`apps/main/src/actions.js`):

| Action | Example |
| --- | --- |
| `set` any user setting (models, voice, follow-up, accent, voice/auto/review mode, isolation, default agent, wake word, name) | "sound more American, maybe Michael" |
| `cleanup` finished workers (done / failed / stopped, never running ones) | "get rid of the ones that finished or broke" |
| `stop`, `remove`, `followup` a specific worker | "the parser one is taking forever, kill it" |
| `land` / `keep` / `discard` a worktree branch | "throw away that muse branch" |
| `project` switch, `hush` | "switch over to the billing api project" |
| `remember` / `forget` a fact (yours, or just this project's) | "keep in mind I hate long answers" |
| `agent`: start creating a specialist (you pick its model on the card) | "I need an agent that reviews SQL migrations" |

Main re-validates every action, writes the outcome to the transcript, and says so out loud if it failed. Jarvis never answers a worker's permission request; you do, on the card or by voice ("yes" / "no").

## Fleet

Workers are child sessions under Jarvis, shown on the ring: glowing while tools run, dim idle, breaking to center on permission. Click a node for the work-view popup (transcript / tool-trace / diff tabs, agent+model switch, stop, undo, compact).

- **Empty fleet?** Spawning with no agents opens a staged gate (purpose → provider → model → effort → confirm) instead of failing, then runs your task on the new agent.
- **Routing** — `@agent` / `ask X to` explicit forms; auto mode picks by keyword overlap with a visible reason; otherwise the default agent (`build`, changeable).

## Projects and worktrees

- **Projects** — the header shows the current project; click it for recent projects or *Open folder…*, or say `switch to project <name>`. Each project has its own brain session (so OpenCode loads that project's `AGENTS.md`/config), memory, and worker parent session. Workers and open worktrees are rebuilt from the server after a restart.
- **Worktrees** — each new delegation chain runs on its own branch (`jarvis/<task>-<id>`) in its own git worktree under `~/.config/jarvis/worktrees`, so parallel workers never share a tree and your checkout is untouched. Follow-ups and reviewer dispatches in the chain reuse it. When it's done: `land it` (commit + `merge --no-ff` into your branch; refuses a dirty checkout or a conflict), `keep it` (commit, keep the branch for a PR), or `discard it` — or the buttons in the work view. `work in my checkout` turns isolation off; non-git folders always run shared.

## Settings

Under the gear icon → system drawer. Models (Jarvis / Fleet / Default agent, all validated live), MCP status, and the audit log of everything Jarvis changed. Shell settings (`~/.config/jarvis/shell.json`) apply next frame and survive restart: accent, density, layout, caption size, audio device, wake word, voice/auto/review mode, isolation (worktree/shared).

## Verify

Unit tests (no server, no model; run in CI on every push and PR):

```sh
npm test        # node --test over routing, dispatch/review parsing, fleet events, memory, worktrees
npm run check   # parse-check every module and the deck script
```

Every capability also has a live proof script against the shared server:

```sh
npm run prove:server   # loop      npm run prove:diff      # diff/undo/redo
npm run prove:voice    # voice     npm run prove:terminal  # shell + PTY
npm run prove:fleet    # fleet     npm run prove:mcp      # MCP + OAuth
npm run prove:shell    # settings  npm run prove:workproj  # worktrees/compact
npm run prove:config   # agents    npm run prove:brain     # memory + model
npm run prove:switch   # switching npm run prove:act      # delegation
npm run prove:forms    # forms     npm run prove:models    # settings models
npm run prove:cmdskill # commands  npm run prove:integration
npm run prove:audio    # engines   npm run prove:sessions  # sessions
npm run prove:parakeet # real Parakeet: `say` -> live VAD path -> routing (Apple Silicon)
npm run prove:jarvis-voice # real Kokoro voice: warm, fixed voice per turn, round-trip via Parakeet
```

## Project layout

```text
apps/main/src/      service, sessions, turn, project, worktrees, fleet, audio,
                    shell, config, forms, terminal, voice, bootstrap,
                    autoroute, brain/ (brain, memory, report)
apps/deck/          canvas fleet, chat transcript, work-view popup, drawer
apps/audio-*/       speech-analyzer (Intel) + parakeet (Apple Silicon) ears,
                    audio-voice: jarvis-voice (Kokoro) speaking voice
plugins/jarvis/     jarvis RPC contract (dispatchWorker, workerList)
packages/proto/     Utterance / intent / event types, app-command allowlist
scripts/prove-*.mjs live proofs, one per capability
tests/unit/         node --test unit tests (fake client, temp git repos)
```

## Status

Shipped and proven: loop, voice, fleet, shell-by-voice, config-by-voice, all
parity surfaces, Parakeet audio on Apple Silicon, brain + act, models panel. See `ROADMAP.md`.

Out of scope by design: session sharing (unsupported server-side), TUI
themes/keybinds (`cli.json` only). Pending: M5 live-mic verification (needs the
hardware), always-on VAD wake.
