# Integrate autoroute (implemented 2026-10-06 — proposal kept for history)

Wired at spawn time in `apps/main/src/main.js` (`parseExplicitAgent` /
`resolveAgent` / `getFleetRegistry`, `@build` stays valid explicit by
decision) and `apps/main/src/autoroute.js`; deck agent select preselects
`settings.defaultAgent`. Proven by `scripts/prove-autoroute.mjs`.
Original proposal follows.

`apps/main/src/autoroute.js` is standalone: pure parse/pick/resolve +
`getFleetRegistry` (agent.list minus BUILTINS). Wire it at spawn time.

## 1. `fleet.spawn` IPC (`apps/main/src/main.js:201`)

Today: `spawnWorker(task, { agent, directory })` trusts the caller.
Proposed:

```js
import { parseExplicitAgent, resolveAgent, getFleetRegistry } from "./autoroute.js";
import { loadStore } from "./shell.js";

const said = parseExplicitAgent(task);
const { settings } = loadStore();
const registry = await getFleetRegistry(client, directory);
const r = resolveAgent(said?.task ?? task, {
  explicit: said, defaultAgent: settings.defaultAgent,
  autoMode: settings.autoMode, registry,
});
if (r.error) throw new Error(`fleet.spawn: ${r.error}`);
const cleanTask = said?.task ?? task;
await spawnWorker(cleanTask, { agent: r.agent, directory });
```

Strip the "@agent" prefix before prompting so the worker never sees it.

## 2. Future brain dispatch (`apps/main/src/brain/`)

Same three calls before dispatch; pass through `r.reason` for the
deck caption ("auto: review->reviewer (3 hits)") so routing is visible.

## 3. Deck agent-select

- Preselect `settings.defaultAgent` (from `agent.list`, not hardcoded).
- Show custom agents from `getFleetRegistry`; hide BUILTINS behind
  an "advanced" toggle. Manual pick sends explicit `{agent}` and
  bypasses autoMode for that turn.

## 4. autoMode toggle wiring

- `set.autoMode` already exists in shell allowlist; deck toggle calls it.
- When `autoMode` flips on, re-resolve only the *next* spawn, never
  retarget running workers. Off means `defaultAgent`, always.
- Dedup: the sibling bootstrap slice defines the same builtin rule;
  keep `BUILTINS` imported from one place once slices merge.

Open question: should "@build" (a builtin) stay valid explicit? Current
`resolveAgent` accepts registry + BUILTINS + defaultAgent; tighten to
registry-only if builtins must never be addressed directly.
