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

- **Memory** — local long-term store (`~/.config/jarvis/memory.json`). Local-embedding first (MiniLM/ONNX, no keys, runs offline), BM25 fallback. Heuristic fact extraction.
- **Act** — think emits single-line `dispatch {"task", "agent?"}` fences. Only exact-shape JSON executes; everything else is words. Every intent runs through autoroute + the bootstrap gate, then spawns.
- **Model** — Luna default, switchable in Settings → Models (validated against the server list, live-switches before saving). `JARVIS_BRAIN_MODEL` env still wins for scripts.

## Voice

- Push-to-talk mic button, or **voice mode** (waveform icon): the mic stays open and `hey <wake>` dispatches hands-free through the same path as typed text.
- Shell phrases (`dim the fleet`, `use the amber accent`) apply locally with no model call. Permission answers (`allow`/`deny`) and worker controls (`stop the worker`) are exact-match controls.

## Fleet

Workers are child sessions under Jarvis, shown on the ring: glowing while tools run, dim idle, breaking to center on permission. Click a node for the work-view popup (transcript / tool-trace / diff tabs, agent+model switch, stop, undo, compact).

- **Empty fleet?** Spawning with no agents opens a staged gate (purpose → provider → model → effort → confirm) instead of failing, then runs your task on the new agent.
- **Routing** — `@agent` / `ask X to` explicit forms; auto mode picks by keyword overlap with a visible reason; otherwise the default agent (`build`, changeable).

## Settings

Under the gear icon → system drawer. Models (Jarvis / Fleet / Default agent, all validated live), MCP status, and the audit log of everything Jarvis changed. Shell settings (`~/.config/jarvis/shell.json`) apply next frame and survive restart: accent, density, layout, caption size, audio device, wake word, voice/auto mode.

## Verify

Every capability has a proof script, each proven live against the shared server:

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
apps/main/src/      service, sessions, fleet, audio, shell, config, forms,
                    terminal, voice, bootstrap, autoroute, brain/
apps/deck/          canvas fleet, chat transcript, work-view popup, drawer
apps/audio-*/       speech-analyzer (Intel) + parakeet (M5) helpers
plugins/jarvis/     jarvis RPC contract (dispatchWorker, workerList)
packages/proto/     Utterance / intent / event types, app-command allowlist
scripts/prove-*.mjs live proofs, one per capability
```

## Status

Shipped and proven: loop, voice, fleet, shell-by-voice, config-by-voice, all
parity surfaces, M5-ready audio, brain + act, models panel. See `ROADMAP.md`.

Out of scope by design: session sharing (unsupported server-side), TUI
themes/keybinds (`cli.json` only). Pending: M5 live-mic verification (needs the
hardware), always-on VAD wake.
