// Voice-mode exit: wake gating is pure strings + shell persist, no mic/model.
// Proves: wake detect/strip, voiceMode off blocks, on/off persist round-trip,
// and "turn voice mode on" routes to app.command (existing shell path).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-voice-mode-")), "shell.json");
process.env.JARVIS_SHELL_FILE = tmp;

const { hasWake, stripWake, isVoiceMode, nextVoiceAction } = await import("../apps/main/src/voice.js");
const { loadStore, applyAppCommand } = await import("../apps/main/src/shell.js");
const { routeUtterance } = await import("../apps/main/src/fleet.js");

const WAKE = "jarvis";
const eq = (a, b) => a === b;
let n = 0;
function check(label, actual, want) {
  n++;
  if (!eq(actual, want)) throw new Error(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
  console.log(`${label}: ok (${JSON.stringify(actual)})`);
}

// 1. Wake detect: hey/bare/ok fire, plain speech does not. Case-insensitive.
check("wake-hey", hasWake("hey jarvis, dim the fleet", WAKE), true);
check("wake-bare", hasWake("jarvis what time is it", WAKE), true);
check("wake-ok", hasWake("ok jarvis dim the fleet", WAKE), true);
check("wake-case", hasWake("Hey Jarvis, dim the fleet", WAKE), true);
check("wake-absent", hasWake("no wake here", WAKE), false);

// 2. Strip: one leading prefix + optional comma/colon gone, remainder kept.
check("strip-hey-comma", stripWake("hey jarvis, dim the fleet", WAKE), "dim the fleet");
check("strip-bare", stripWake("jarvis what time is it", WAKE), "what time is it");
check("strip-colon", stripWake("hey jarvis: dim the fleet", WAKE), "dim the fleet");
check("strip-empty", stripWake("hey jarvis", WAKE), "");

// 3. Gate: on + wake + remainder routes; bare wake is empty; no wake or mode off ignored.
let r = nextVoiceAction("hey jarvis, dim the fleet", { voiceMode: "on", wakeWord: WAKE });
if (r.action !== "wake-task" || r.text !== "dim the fleet") throw new Error(`gate-task: ${JSON.stringify(r)}`);
console.log(`gate-task: ok (${JSON.stringify(r.text)})`);
n++;
check("gate-empty", nextVoiceAction("jarvis", { voiceMode: "on", wakeWord: WAKE }).action, "wake-empty");
check("gate-nowake", nextVoiceAction("no wake here", { voiceMode: "on", wakeWord: WAKE }).action, "ignored");
check("gate-off", nextVoiceAction("hey jarvis, dim the fleet", { voiceMode: "off", wakeWord: WAKE }).action, "ignored");

// 4. Stripped remainder still routes: shell phrase local, question is a prompt.
let routed = routeUtterance(stripWake("hey jarvis, dim the fleet", WAKE));
if (routed.route !== "app.command" || routed.name !== "set.accent") throw new Error(`route-shell: ${JSON.stringify(routed)}`);
console.log(`route-shell: ok (${routed.name}=${routed.args.value})`);
n++;
routed = routeUtterance(stripWake("jarvis what time is it", WAKE));
if (routed.route !== "prompt") throw new Error(`route-prompt: ${JSON.stringify(routed)}`);
console.log(`route-prompt: ok (${routed.route})`);
n++;

// 5. Mode persist: set.voiceMode on/off round-trips through the temp shell file.
let store = loadStore();
if (isVoiceMode(store) !== false) throw new Error("expected voiceMode off by default");
applyAppCommand(store, "set.voiceMode", { value: "on" });
if (!isVoiceMode(store)) throw new Error("voiceMode on not applied");
if (loadStore(tmp).settings.voiceMode !== "on") throw new Error("voiceMode on did not persist");
console.log("persist-on: ok (voiceMode=on survives reload)");
n++;
applyAppCommand(store, "set.voiceMode", { value: "off" });
if (isVoiceMode(store)) throw new Error("voiceMode off not applied");
if (loadStore(tmp).settings.voiceMode !== "off") throw new Error("voiceMode off did not persist");
console.log("persist-off: ok (voiceMode=off survives reload)");
n++;

// 6. Spoken/typed "turn voice mode on" is an app.command, never a model prompt.
routed = routeUtterance("turn voice mode on");
if (routed.route !== "app.command" || routed.name !== "set.voiceMode" || routed.args?.value !== "on") {
  throw new Error(`route-voicemode: ${JSON.stringify(routed)}`);
}
console.log(`route-voicemode: ok (${routed.name}=${routed.args.value})`);
n++;

console.log(`voice-mode-ok (${n} checks)`);
process.exit(0);
