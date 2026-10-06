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
npm run build:audio   # speech helper binary (Intel: SpeechAnalyzer)
npm --workspace apps/main run dev   # launch the deck
```

Type `hi`. Or press the mic and say `hey jarvis, dim the fleet`.

## How it works

Three processes, one command bus:

| Piece | Role |
| --- | --- |
| `apps/deck` | The deck. No Node, no OpenCode client — draws and sends intents over IPC. |
| `apps/main` | Owns `@opencode/client` and `Service.ensure()`. The only place that changes settings or writes config. |
| `apps/audio-*` | Native mic helper. Intel: Apple SpeechAnalyzer. M5: Parakeet TDT 0.6B v3 via FluidAudio. Emits partial captions + finished utterances. Audio never leaves the box. |

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
- Shell phrases (`dim the fleet`, `use the amber accent`) apply locally with no model call. Permission answers (`allow`/`deny`) and worker controls (`stop the worker`) are exact-match controls.

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
npm run prove:audio    # M5-ready  npm run prove:sessions  # sessions
```

## Project layout

```text
apps/main/src/      service, sessions, turn, project, worktrees, fleet, audio,
                    shell, config, forms, terminal, voice, bootstrap,
                    autoroute, brain/ (brain, memory, report)
apps/deck/          canvas fleet, chat transcript, work-view popup, drawer
apps/audio-*/       speech-analyzer (Intel) + parakeet (M5) helpers
plugins/jarvis/     jarvis RPC contract (dispatchWorker, workerList)
packages/proto/     Utterance / intent / event types, app-command allowlist
scripts/prove-*.mjs live proofs, one per capability
tests/unit/         node --test unit tests (fake client, temp git repos)
```

## Status

Shipped and proven: loop, voice, fleet, shell-by-voice, config-by-voice, all
parity surfaces, M5-ready audio, brain + act, models panel. See `ROADMAP.md`.

Out of scope by design: session sharing (unsupported server-side), TUI
themes/keybinds (`cli.json` only). Pending: M5 live-mic verification (needs the
hardware), always-on VAD wake.
