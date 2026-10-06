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

Still open: LLM fact extraction for memory (extractCandidates is still
heuristic regex today), M5 live-mic verification (binary drop-in proven on
Intel only; 16 kHz resample / VAD tuning notes in helper.swift unverified).
