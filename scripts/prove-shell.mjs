// Step 4 exit: "use the amber accent" applies before the next frame and survives restart.
// No model calls. Shell bucket only: allowlisted app commands + audit log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-shell-")), "shell.json");
process.env.JARVIS_SHELL_FILE = tmp;

const { routeUtterance } = await import("../apps/main/src/fleet.js");
const { loadStore, applyAppCommand, ACCENTS } = await import("../apps/main/src/shell.js");

// 1. Routing: shell phrases are local commands, never model prompts.
const shellCases = [
  ["use the amber accent", "set.accent", "amber"],
  ["set the accent to amber", "set.accent", "amber"],
  ["use amber accent", "set.accent", "amber"],
  ["dim the fleet", "set.accent", "dim"],
  ["set density to compact", "set.density", "compact"],
  ["set layout to wide", "set.layout", "wide"],
  ["set caption size to large", "set.captionSize", "large"],
  ["set audio device to headset", "set.audioDevice", "headset"],
  ["set wake word to computer", "set.wake", "computer"],
  ["set the theme to amber", "set.accent", "amber"],
];
for (const [text, name, value] of shellCases) {
  const r = routeUtterance(text, false);
  if (r.route !== "app.command" || r.name !== name || r.args?.value !== value) {
    throw new Error(`route ${JSON.stringify(text)}: got ${JSON.stringify(r)}, want ${name}=${value}`);
  }
}
// Guards: model work and widening must NOT match shell.
const promptCases = [
  "make a reviewer that cannot edit, then have it look at auth",
  "let every agent run any shell command",
  "use the invisible accent",
  "allow",
];
for (const text of promptCases) {
  const r = routeUtterance(text, false);
  if (r.route === "app.command") throw new Error(`eval leak: ${JSON.stringify(text)} routed to ${r.name}`);
}
console.log("route-ok: 10 shell phrases local, 4 non-shell stay model-side");

// 2. Apply amber: live before the next frame (synchronous, in-memory + file).
let store = loadStore();
const entry = applyAppCommand(store, "set.accent", { value: "amber" });
if (store.settings.accent !== "amber") throw new Error("accent not applied");
if (entry.bucket !== "shell" || entry.live !== true || entry.needsRestart !== false) {
  throw new Error(`bad audit entry: ${JSON.stringify(entry)}`);
}
if (ACCENTS.amber !== "#f5a623") throw new Error("amber hex drift");
console.log(`apply-ok: accent=${store.settings.accent} (${ACCENTS.amber}) live=${entry.live}`);

// 3. Survives restart: fresh store instance reads the same file.
const store2 = loadStore(tmp);
if (store2.settings.accent !== "amber") throw new Error("accent did not survive restart");
if (!store2.audit.some((e) => e.what === "set.accent amber")) throw new Error("audit did not survive restart");
console.log("persist-ok: amber + audit survive reload");

// 4. Validation, not silent apply.
let threw = 0;
try { applyAppCommand(loadStore(), "set.accent", { value: "invisible" }); } catch { threw++; }
try { applyAppCommand(loadStore(), "shell.exec", { value: "rm -rf" }); } catch { threw++; }
if (threw !== 2) throw new Error("validation gap");
console.log("validate-ok: unknown accent + non-allowlisted command rejected");
console.log("shell-ok");
process.exit(0);
