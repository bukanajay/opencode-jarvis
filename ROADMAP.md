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

Pending details to lock when each slice starts: wake-word engine (transcript match
vs always-on VAD), effort mapping (steps/variant), auto-pick heuristics.
