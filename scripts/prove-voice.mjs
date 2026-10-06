// Step 2 exit: a spoken sentence and a typed sentence are the same kind of message.
// Proves: helper partials -> final -> Utterance{source:speech} -> same promptJarvis path as typed.
import { listenOnce, toUtterance } from "../apps/main/src/audio.js";
import { promptJarvis } from "../apps/main/src/sessions.js";

const SENTENCE = process.argv[2] ?? "Reply with exactly: voice-ok";

const partials = [];
const fin = await listenOnce({
  simulate: SENTENCE,
  onPartial: (p) => partials.push(p),
});
console.log(`partials=${partials.length} final=${JSON.stringify(fin.text)}`);
if (partials.length < 2) throw new Error("expected progressive partials");
if (fin.text !== SENTENCE) throw new Error("final mismatch");

const spoken = toUtterance(fin);
const typed = { id: "typed-1", text: SENTENCE, source: "typed", engine: "typed", committedAt: Date.now() };
for (const k of ["id", "text", "source", "engine", "committedAt"]) {
  if (!(k in spoken) || !(k in typed)) throw new Error(`utterance key missing: ${k}`);
}
if (spoken.source !== "speech" || spoken.engine !== "speech-analyzer") throw new Error("speech utterance mislabeled");
console.log(`spoken=${JSON.stringify(spoken).slice(0, 160)}`);
console.log("shape-ok: speech and typed are the same Utterance kind");

// Same prompt path as text. One live call.
let streamed = "";
const r = await promptJarvis(spoken.text, (d) => { streamed += d; });
console.log(`model=${r.modelUsed?.providerID}/${r.modelUsed?.id} status=${r.status}`);
console.log("--- reply ---");
console.log(streamed || "(no text deltas)");
if (r.status !== "ok") { console.log("voice-failed"); process.exit(1); }
console.log("voice-ok");
process.exit(0);
