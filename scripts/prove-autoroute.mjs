// Prove autoroute: pure parse/pick/resolve + ONE live dispatch of the resolved agent.
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
import { BUILTINS, getFleetRegistry, parseExplicitAgent, pickAgent, resolveAgent } from "../apps/main/src/autoroute.js";
import { spawnWorker, deleteWorker } from "../apps/main/src/fleet.js";
import { ensureClient } from "../apps/main/src/service.js";
import { parseModelRef } from "../apps/main/src/sessions.js";

const DIR = process.cwd();
const DEFAULT = "build";
if (!BUILTINS.includes("build") || BUILTINS.length !== 8) throw new Error("BUILTINS drifted");

// 1. parseExplicitAgent: 4 forms hit, 3 plain sentences miss.
const forms = [
  ["@reviewer review the auth module", "reviewer", "review the auth module"],
  ["ask reviewer to check the auth module", "reviewer", "check the auth module"],
  ["using reviewer check the auth module", "reviewer", "check the auth module"],
  ["with reviewer check the auth module", "reviewer", "check the auth module"],
];
for (const [text, agent, task] of forms) {
  const got = parseExplicitAgent(text);
  if (got?.agent !== agent || got?.task !== task) throw new Error(`parse miss: ${JSON.stringify(text)} -> ${JSON.stringify(got)}`);
}
const plain = [
  "review the auth module for bugs",
  "please help me with the build",
  "what is the status of the fleet",
];
for (const text of plain) {
  if (parseExplicitAgent(text) !== null) throw new Error(`parse leak: ${JSON.stringify(text)} matched`);
}
console.log("parse-ok: 4 forms matched, 3 plain sentences rejected");

// 2. pickAgent on a fixed registry.
const REG = [
  { id: "reviewer", description: "review code quality bugs" },
  { id: "builder", description: "build code features writes" },
];
const r1 = pickAgent("review the auth module for bugs and quality", REG, DEFAULT);
if (r1.agent !== "reviewer") throw new Error(`pick review failed: ${JSON.stringify(r1)}`);
const r2 = pickAgent("fix code now", REG, DEFAULT);
if (r2.agent !== DEFAULT) throw new Error(`pick tie failed (want default): ${JSON.stringify(r2)}`);
const r3 = pickAgent("review everything", [], DEFAULT);
if (r3.agent !== DEFAULT) throw new Error(`pick empty failed (want default): ${JSON.stringify(r3)}`);
console.log(`pick-ok: review->${r1.agent} (${r1.reason}), tie->${r2.agent}, empty->${r3.agent}`);

// 3. resolveAgent: explicit validated, autoMode picks, manual falls back.
const okExp = resolveAgent("whatever", { explicit: parseExplicitAgent("@reviewer check this"), defaultAgent: DEFAULT, autoMode: "off", registry: REG });
if (okExp.agent !== "reviewer") throw new Error(`resolve explicit failed: ${JSON.stringify(okExp)}`);
const badExp = resolveAgent("whatever", { explicit: parseExplicitAgent("@ghost do this"), defaultAgent: DEFAULT, autoMode: "off", registry: REG });
if (!badExp.error) throw new Error("resolve accepted an unknown agent");
const auto = resolveAgent("review the auth module for bugs and quality", { defaultAgent: DEFAULT, autoMode: "on", registry: REG });
if (auto.agent !== "reviewer") throw new Error(`resolve auto failed: ${JSON.stringify(auto)}`);
const manual = resolveAgent("review everything urgently", { defaultAgent: DEFAULT, autoMode: "off", registry: REG });
if (manual.agent !== DEFAULT) throw new Error(`resolve manual failed: ${JSON.stringify(manual)}`);
console.log("resolve-ok: explicit validated, auto picks, manual defaults, unknown rejected");

// 4. ONE live dispatch: resolve against the real registry, run a trivial turn.
const { client } = await ensureClient();
const real = await getFleetRegistry(client, DIR).catch(() => []);
console.log(`registry-ok: ${real.length} custom agents (builtins excluded)`);
const resolved = resolveAgent("Reply with the single word ok.", { defaultAgent: DEFAULT, autoMode: "off", registry: real });
if (!resolved.agent) throw new Error(`live resolve failed: ${JSON.stringify(resolved)}`);
let wid = null;
try {
  const w = await spawnWorker("Reply with the single word ok. Change nothing, run no tools.", { agent: resolved.agent }).catch(async (e) => {
    if (String(e?.message ?? e).includes("403")) { // free-tier subagent guard, same as prove-config
      const m = parseModelRef(process.env.REVIEWER_MODEL) ?? { providerID: "openrouter", id: "apodex/apodex-1.1-mini:free" };
      return spawnWorker("Reply with the single word ok. Change nothing, run no tools.", { agent: resolved.agent, model: m });
    }
    throw e;
  });
  wid = w.sessionID;
  await waitForDone(client, wid, 110000);
  console.log(`dispatch-ok: ${resolved.agent} completed a trivial turn`);
} finally {
  if (wid) await deleteWorker(wid).catch(() => {});
}
console.log("autoroute-ok");
process.exit(0);

async function waitForDone(c, sessionID, ms) {
  const sub = c.event.subscribe();
  const t0 = Date.now();
  try {
    for await (const ev of sub) {
      const d = ev.data ?? {};
      if (d.sessionID !== sessionID) continue;
      if (ev.type === "session.execution.succeeded") return;
      if (ev.type === "session.execution.failed") throw new Error(`worker failed: ${JSON.stringify(d.error).slice(0, 200)}`);
      if (Date.now() - t0 > ms) throw new Error("worker timeout");
    }
  } finally {
    if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
  }
}
