// Brain core: LangGraph recall → think → persist, memory round-trip,
// model switch via OpenCode list, end-to-end reply.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-mem-")), "memory.json");
process.env.JARVIS_MEMORY_FILE = tmp;
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";

const { loadMemory, remember, recall, extractCandidates } = await import("../apps/main/src/brain/memory.js");
const { brainRespond, getBrainModel, setBrainModel } = await import("../apps/main/src/brain/brain.js");

// 1. Memory round-trip (no model).
let mem = loadMemory();
remember(mem, "user prefers amber accent", ["test"]);
remember(mem, "reviewer agent exists", ["test"]);
mem = loadMemory();
const hits = recall(mem, "which accent does the user prefer?");
if (!hits.some((f) => f.text.includes("amber"))) throw new Error("recall missed");
if (recall(mem, "quantum banana extradition").length !== 0) throw new Error("recall leak");
const ext = extractCandidates("remember my editor is vim");
if (!ext.some((s) => s.includes("vim"))) throw new Error("extract missed");
console.log("memory-ok: write, recall, extract");

// 2. Brain model: Luna default, switch validated against OpenCode list.
const def = getBrainModel();
if (def.providerID !== "opencode-go" || def.id !== "gpt-6-luna") {
  throw new Error(`brain default is not Luna: ${JSON.stringify(def)}`);
}
let threw = false;
try { await setBrainModel("nope", "missing"); } catch { threw = true; }
if (!threw) throw new Error("unknown model accepted");
await setBrainModel("opencode", "fledge-alpha-free");
if (getBrainModel().id !== "fledge-alpha-free") throw new Error("switch did not stick");
console.log("model-ok: Luna default, unknown rejected, switch sticks");

// 3. End-to-end brain turn with memory seeded.
mem = loadMemory();
remember(mem, "user prefers amber accent", ["test"]);
let streamed = "";
const r = await brainRespond("Reply with exactly: brain-ok. No tools.", (d) => { streamed += d; });
if (r.status !== "ok" || !streamed.includes("brain-ok")) {
  throw new Error(`brain turn failed (${r.status}): ${JSON.stringify(streamed.slice(0, 120))}`);
}
console.log(`turn-ok: via ${r.modelUsed?.providerID}/${r.modelUsed?.id}, memories=${r.memoriesUsed.length}`);

// 4. Persist node wrote from a remember-phrase turn.
const r2 = await brainRespond("Remember my ship is called Aurora. Reply with exactly: noted.", () => {});
mem = loadMemory();
if (!mem.facts.some((f) => f.text.includes("Aurora"))) throw new Error("persist missed");
console.log("persist-ok: Aurora stored");
console.log("brain-ok");
process.exit(0);
