// Step 7 exit: the deck does not care which engine heard it.
// Both helpers run the same simulate through the same listenOnce/toUtterance,
// producing the same Utterance kind with different engine labels.
import { execFile } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const SA_SRC = path.join(ROOT, "apps/audio-speech-analyzer/src/helper.swift");
const SA_BIN = path.join(ROOT, "apps/audio-speech-analyzer/bin/speech-analyzer");
const PQ_SRC = path.join(ROOT, "apps/audio-parakeet/src/sim.swift");
const PQ_BIN = path.join(ROOT, "apps/audio-parakeet/bin/parakeet-sim");

await import("node:fs").then((fs) => fs.mkdirSync(path.dirname(PQ_BIN), { recursive: true }));
for (const [src, bin] of [[SA_SRC, SA_BIN], [PQ_SRC, PQ_BIN]]) {
  await new Promise((resolve, reject) => {
    execFile("swiftc", ["-O", src, "-o", bin], (err, stdout, stderr) => {
      if (err) reject(new Error(`swiftc ${src}: ${stderr ?? err.message}`));
      else resolve();
    });
  });
}
console.log("build-ok: both helpers compiled");

const { listenOnce, toUtterance, resolveEngine } = await import("../apps/main/src/audio.js");
const { routeUtterance } = await import("../apps/main/src/fleet.js");

try { resolveEngine("bogus"); throw new Error("no throw"); } catch (e) { if (!/unknown audio engine/.test(e.message)) throw e; }
console.log("engine-ok: unknown engines rejected");

// Same sentence, both engines, same path.
const results = {};
for (const engine of ["speech-analyzer", "parakeet"]) {
  const partials = [];
  const fin = await listenOnce({ engine, simulate: "use the amber accent", onPartial: (p) => partials.push(p) });
  if (partials.length < 2 || fin.text !== "use the amber accent") throw new Error(`${engine}: protocol drift`);
  results[engine] = toUtterance(fin);
}
const [sa, pq] = [results["speech-analyzer"], results.parakeet];
for (const k of ["id", "text", "source", "engine", "committedAt"]) {
  if (!(k in sa) || !(k in pq)) throw new Error(`utterance key missing: ${k}`);
}
if (sa.source !== "speech" || pq.source !== "speech") throw new Error("source drift");
if (sa.engine !== "speech-analyzer" || pq.engine !== "parakeet-v3") throw new Error("engine labels wrong");
if (JSON.stringify(Object.keys(sa).sort()) !== JSON.stringify(Object.keys(pq).sort())) {
  throw new Error("utterance shape differs by engine");
}
console.log(`deck-ok: identical Utterance kind (engines: ${sa.engine}, ${pq.engine})`);

// Routing is engine-blind: same text, same route, no model involved.
for (const u of [sa, pq]) {
  const r = routeUtterance(u.text, false);
  if (r.route !== "app.command" || r.name !== "set.accent") throw new Error(`${u.engine} misrouted`);
}
console.log("route-ok: both engines take the local path");
console.log("audio-ok");
process.exit(0);
