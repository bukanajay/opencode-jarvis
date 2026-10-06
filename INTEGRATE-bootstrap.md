# INTEGRATE-bootstrap (proposal — nothing wired yet)

## Gate before dispatch
In `main.js`, inside the `fleet.spawn` handler (today line ~201 calls
`spawnWorker(task, { agent, directory })` directly): when `agent` is absent,
call `ensureFleetOrAsk(client, directory)` first.
- `ready` → dispatch as today (`agent` stays unset → worker default).
- `empty` → do NOT spawn. `startCreate([])`, show the empty prompt in a
  blocking card, and stash the original `{ task, directory }` beside the
  `pendingBootstraps` id so `done` can resume the spawn.

## Routing answers while a bootstrap is pending
Mirror the `pendingConfigs` / `latestConfigPending` pattern (`main.js` ~17):
`latestBootstrapPending()` = last key of `pendingBootstraps`. While one exists,
`commitText` routes the utterance to `answerCreate(conv, text, ctx)` instead
of `routeUtterance`/`spawnWorker`, where `ctx` = `{ providers, modelsByProvider,
client, directory }` prefetched via `listProviders` / `listModelsFor`.
- The initial empty prompt is yes/no: "yes" → `startCreate` (stage `purpose`);
  "no"/"cancel" → `cancelled`, drop the stashed task.
- Each `answerCreate` return renders the next card (`stage`/`prompt`/`options`);
  `done` → spawn the stashed task with `agent: name`; `cancelled` → dismiss.

## Deck card sketch (reuse blocking-card mount, `deck/index.html` ~467)
Same shell as perm/cfg cards: title "New agent", body = `prompt`,
option chips = `options` (providers / models / low|medium|high), confirm card
renders the exact `spec` JSON (`{name, provider, model, effort, permissions}`),
yes/no buttons. No new card infra — new template only.

## Proposed IPC (proposals only, not implemented)
- `bootstrap.answer` (`{ id, text }`) → routes one answer through `answerCreate`,
  returns `{ stage, prompt, options?, spec?, name?, note? }`.
- `bootstrap.cancel` (`{ id }`) → forces `cancelled`, drops stashed task.
Open: where the stashed pre-gate task lives (main-local map vs inside the conv).
