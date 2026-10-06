// Models under settings: shell format validation, precedence, live validation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-model-")), "shell.json");
process.env.JARVIS_SHELL_FILE = tmp;
delete process.env.WORKER_MODEL;
delete process.env.JARVIS_MODEL;
delete process.env.JARVIS_BRAIN_MODEL;

const { loadStore, applyAppCommand } = await import("../apps/main/src/shell.js");
const { resolveWorkerModel } = await import("../apps/main/src/fleet.js");
const { wantedBrainModel } = await import("../apps/main/src/brain/brain.js");

// 1. Format validation: provider/id only.
let store = loadStore();
for (const [name, bad] of [["set.jarvisModel", "luna"], ["set.workerModel", "no-slash-here"], ["set.jarvisModel", "/x"]]) {
  let threw = false;
  try { applyAppCommand(store, name, { value: bad }); } catch { threw = true; }
  if (!threw) throw new Error(`${name} accepted ${JSON.stringify(bad)}`);
}
applyAppCommand(store, "set.jarvisModel", { value: "opencode-go/gpt-6-luna" });
applyAppCommand(store, "set.workerModel", { value: "openrouter/apodex" });
const def = applyAppCommand(loadStore(), "set.defaultAgent", { value: "reviewer" });
if (def.what !== "set.defaultAgent reviewer") throw new Error("defaultAgent apply wrong");
console.log("validate-ok: bad models rejected, good saved");

// 2. Precedence: env > shell > const.
if (JSON.stringify(resolveWorkerModel()) !== JSON.stringify({ providerID: "openrouter", id: "apodex" })) {
  throw new Error(`worker model wrong: ${JSON.stringify(resolveWorkerModel())}`);
}
process.env.WORKER_MODEL = "openrouter/other";
if (resolveWorkerModel().id !== "other") throw new Error("env override lost");
delete process.env.WORKER_MODEL;
if (JSON.stringify(wantedBrainModel()) !== JSON.stringify({ providerID: "opencode-go", id: "gpt-6-luna" })) {
  throw new Error(`brain model wrong: ${JSON.stringify(wantedBrainModel())}`);
}
console.log("precedence-ok: env > shell > default");

// 3. Live: unknown model rejected before save; known switches.
const { setBrainModel, getBrainModel } = await import("../apps/main/src/brain/brain.js");
let threw = false;
try { await setBrainModel("nope", "missing"); } catch { threw = true; }
if (!threw) throw new Error("unknown model accepted live");
await setBrainModel("opencode", "fledge-alpha-free");
if (getBrainModel().id !== "fledge-alpha-free") throw new Error("live switch missed");
await setBrainModel("opencode-go", "gpt-6-luna");
console.log("live-ok: unknown rejected, fledge ok, luna restored");
console.log("models-ok");
process.exit(0);
