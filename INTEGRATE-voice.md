# Voice-mode integration (implemented 2026-10-06 — proposal kept for history)

Wired in `apps/main/src/main.js` (`voiceLoop` beside `commitText`,
`isListening` guard both directions) and `apps/main/src/voice.js`; deck
Voice toggle next to Mic in `apps/deck/index.html`. No new IPC — wake-task
text reuses `commitText`. Proven by `scripts/prove-voice-mode.mjs`.
Original proposal follows.

## Loop (new `startVoiceLoop` in main.js, beside `commitText`)

```js
import { isListening, listenOnce, toUtterance } from "./audio.js";
import { isVoiceMode, nextVoiceAction } from "./voice.js";
async function voiceLoop(commitText, onCaption) {
  while (isVoiceMode(shellStore())) {
    if (isListening()) return; // one-shot owns the mic; loop exits, restarts on toggle
    let fin;
    try { fin = await listenOnce({ onPartial: onCaption }); }
    catch { continue; } // denial/timeout: caption shows error, loop retries
    const s = shellStore().settings;
    const next = nextVoiceAction(fin.text, { voiceMode: s.voiceMode, wakeWord: s.wake });
    if (next.action === "wake-task") await commitText(next.text);
    // wake-empty -> caption hint "heard <wake>, say a command"; ignored -> keep looping
  }
}
```
`wake-task` text feeds existing `commitText` (fleet `routeUtterance`), so
"hey jarvis, dim the fleet" applies `set.accent` with no new IPC.

## Mic button when voiceMode on

Push-to-talk (`audio.start` handler) still works one-shot via `toUtterance` +
`commitText`. Guard both directions with existing `isListening()`: handler
already returns `already-listening`; loop above returns instead of doubling.
Toggling mode off calls existing `stopListening()` to break the loop's listen.

## Deck voice-toggle sketch (no new IPC)

Button reads `settings.get`, sends existing `app.command`
`{ name: "set.voiceMode", args: { value: on|off } }`, rerenders on
`settings.applied`. Starting the loop needs one trigger: PROPOSAL (new IPC
`voice.loop`, flagged) or renderer polls `settings.get`. Prefer new `voice.loop`.
