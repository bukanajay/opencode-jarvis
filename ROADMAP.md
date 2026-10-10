# Jarvis roadmap

Built and proven (see README): Loop, Voice, Fleet, Shell, Config, Parity (8 surfaces), M5 audio.

## Brain (in progress)

LangGraph loop in Main, OpenCode session as the reasoner (Luna default, switchable
via OpenCode model list, no new keys). Local long-term memory.

- [x] Brain core: recall → think → respond → persist, memory store, brain model switch
- [x] Voice mode toggle (shell `set.voiceMode on|off`): off = type + read; on = keep
  listening, `hey jarvis` wake detection, hands-free dispatch through the same graph
- [x] Fleet bootstrap: empty fleet replies "no agent", asks to create; yes → ask
  provider → model → effort; creates the agent; repeatable for N agents
- [x] Default agent + auto mode (shell `set.defaultAgent`, `set.autoMode on|off`):
  no agent named → default; auto on → Jarvis picks from task text + fleet registry
- [x] Act: structured dispatch from think through autoroute + bootstrap gate

## Dev assistant

- [x] Unit tests + CI (`npm test`, `npm run check`, GitHub Actions)
- [x] Read-only brain: reads the project, delegates every change
- [x] Closed loop: worker reports → review turn → followup / dispatch, bounded rounds
- [x] Worktree per chain with land / keep / discard
- [x] Projects: switcher, per-project sessions + memory, restart rehydration
- [ ] LLM routing (brain picks the agent, keywords as offline fallback)
- [ ] Memory list/forget in the drawer; LLM fact extraction
- [ ] Git/GitHub: PR from a kept branch, CI status in reviews
- [ ] Test-command detection per project, fed to followups
- [ ] Split main.js IPC handlers and the deck into modules

- [x] Parakeet live engine on Apple Silicon (M5 Pro): real binary, 16 kHz resample,
  energy VAD + silence commit, rolling partials; default engine when built
  (`npm run prove:parakeet` runs real speech through the live path)

- [x] Jarvis's voice: Kokoro-82M on device (`jarvis-voice`), one fixed voice
  (`set.voice`, default bm_george), audio-driven core animation; pinned system
  voice fallback on Intel

- [x] Jarvis acts on its own deck: live deck state in the brain prompt, validated
  `jarvis` action fence (settings, cleanup/stop/remove/follow-up workers,
  land/keep/discard, project, hush); machine checks always delegated; spoken
  permission prompts answered by voice

Still open: LLM fact extraction for memory (extractCandidates is still
heuristic regex today), VAD threshold tuning against a real room mic (proven
on synthesized speech; tune via `JARVIS_PARAKEET_*` env), keep the parakeet
process warm across utterances instead of one spawn per utterance.
