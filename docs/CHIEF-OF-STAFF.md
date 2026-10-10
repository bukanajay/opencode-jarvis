# Jarvis → chief of staff

Where Jarvis is today, what the frontier assistants do (October 2026), and a
phased plan to turn Jarvis from a voice deck for coding agents into the chief
of staff of a startup.

## Where we are

Jarvis is a local, voice-first operator over a fleet of OpenCode workers:

- **Hears and speaks on device:** Parakeet speech to text, the Kokoro voice,
  wake word plus conversation mode, spoken approvals.
- **Thinks with any model:** its read-only brain sees the live deck state and
  delegates every change or machine action to workers. Worktree isolation,
  review loop, follow-ups.
- **Acts on its own deck:** settings, fleet, branches, projects, memory, new
  agents. Every action is validated, audited, and never answers a permission
  on the user's behalf.

It is strong on the *codebase*. A chief of staff lives in the *company*:
calendar, inbox, Slack, customers, money, commitments, people. That is the gap.

## What the frontier does (Oct 2026)

| | Shape | What matters for us |
| --- | --- | --- |
| **OpenAI Dots** | always-on agents, each with its own cloud computer and browser, 4,000+ app connectors, reachable in ChatGPT, Slack and Teams; $500/mo plan | keeps working between conversations on *goals*, brings back *decisions for review* (e.g. drafts an overdue invoice, sends after approval) |
| **Grok Bot** | own cloud computer per bot (browser, files, CLI), signs into tools, runs until approval is needed; learns your corrections, style and when to ask; ~$300/mo, beta | *learning when to ask*, persistent preferences |
| **Meta Muse** (Spark 1.1–1.3, Muse Code) | agentic Meta AI that plans projects, acts on calendar and email, keeps working after the app closes; strong coding agent | calendar and email are table stakes; Meta has not detailed its permissioning |

Common pattern: **goals, not prompts · always on · connected to everything ·
an approval queue · learns the user.**

## Where Jarvis can win

The frontier products are cloud, closed, single-vendor and $300–500 a month.
Jarvis can be the opposite and still be better at the job:

1. **Private by construction.** Voice, meetings and memory stay on your Mac;
   only the model calls you choose leave it. A founder can let it hear board
   prep, payroll and fundraising.
2. **Native to your machine and code.** It already runs your repo, your shell
   and your AWS. Cloud bots reach that through a browser.
3. **Model-agnostic.** The best model per job, cost caps, no lock-in. When a
   better model ships, Jarvis gets better the same day.
4. **Voice-first operator.** Talk while you walk, approve by voice, get
   interrupted only when it matters.
5. **Auditable.** Every action is a validated fence plus an audit entry; policies
   are config, not a vendor promise.

Honest gaps: they run when the laptop is closed, ship thousands of
connectors, and have polish. The plan below closes the first two (a daemon
plus MCP connectors); polish is earned by using it daily.

## Plan

### Phase 0: foundation (1–2 weeks)

- **Daemon / UI split.** Move the brain, fleet, voice and scheduler into a
  `jarvisd` LaunchAgent that runs at login. The deck becomes one client;
  others come later. Jarvis keeps working with the window closed.
- **Break up `main.js`** into IPC, voice loop, commit pipeline and action
  executor modules (already on the roadmap).
- **Eval harness.** Turn this session's ad-hoc live checks ("clean up workers",
  "is claude installed", "sound like Michael") into a scored suite run per
  model, so brain prompt or model changes are measured, not guessed.
- **Cost and health telemetry.** Tokens and dollars per turn, worker and model;
  daily budget; health of the helpers and the OpenCode server.

### Phase 1: always on (2–4 weeks)

- **Goals and routines.** "Every weekday at 8:30 brief me", "watch CI on main",
  "tell me if AWS spend jumps 20%". Stored goals with schedule or trigger,
  owner agent, budget, and a stop condition.
- **Morning brief (voice and text):** calendar, what changed overnight (PRs, CI,
  errors, AWS cost, Stripe), fleet results, the three decisions waiting on
  you. Read aloud when you say "good morning".
- **Decision inbox.** One queue for everything that needs you: permissions,
  drafts to send, spend above a threshold, merges. Approve by voice, the deck
  or your phone. It replaces one-off modal cards.
- **Reach when away.** A Slack or Telegram bridge: message Jarvis, get the
  brief, approve decisions from your phone.

### Phase 2: company brain (4–6 weeks)

- **Connectors via MCP,** managed by Jarvis itself ("connect my calendar"):
  Google Workspace (Gmail, Calendar, Drive), Slack, GitHub, Linear or Jira,
  Stripe, AWS (already used), HubSpot and Notion as needed.
- **Structured memory:** people, companies, customers, decisions, commitments,
  metrics, each with sources and dates. LLM extraction replaces the regex
  heuristics. Memory list, edit and forget in the drawer.
- **Commitment tracker:** what you promised whom by when, pulled from email,
  Slack and meetings; nudges before it slips.
- **Meeting copilot:** local capture with Parakeet (no bot joins the call),
  then notes, decisions and action items, with drafts of the follow-ups in
  your voice.

### Phase 3: delegated operations (6–10 weeks)

- **Autonomy policy** per action class: read → draft → send → spend → deploy.
  Each class is auto, ask, or never, per connector, with budgets. Policies are
  learned from your approvals ("you always approve CI reruns: auto?").
- **Standing teams:** an engineering crew (today's fleet), an ops agent (AWS,
  billing, vendors), research (market, competitors, hiring), and comms (investor
  update, customer emails, changelog), each owning goals and reporting into
  the brief.
- **Founder workflows:** monthly investor update drafted from metrics and
  shipped work; hiring pipeline (screen, schedule, debrief); customer follow-ups
  from support and CRM; board-deck prep.
- **Safety for real-world access:** content from email and the web is
  untrusted (prompt-injection guardrails, no instructions from data); scoped
  tokens; a kill switch ("Jarvis, stand down").

### Phase 4: team mode

Shared company memory and decision inbox for co-founders and leads,
per-person voices and permissions, and Jarvis as the team's operator in
Slack.

## Recommended next step

Start Phase 0's daemon split together with Phase 1's **morning brief and
decision inbox**. That is the smallest slice that changes the experience from
"a tool I open" to "a chief of staff that was working while I slept": it
reuses everything built so far (voice, actions, fleet, AWS access) and makes
every later connector pay off immediately.
