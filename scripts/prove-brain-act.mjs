// Brain act: structured dispatch fences parse, validate, strip, and filter;
// the parsed chain resolves + spawns live.
process.env.JARVIS_BRAIN_MODEL ??= "opencode/fledge-alpha-free";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";

const { parseDispatches, stripDispatches, fencedFilter, buildThinkPrompt, brainRespond } = await import("../apps/main/src/brain/brain.js");
const { resolveAgent, getFleetRegistry } = await import("../apps/main/src/autoroute.js");
const { spawnWorker, deleteWorker } = await import("../apps/main/src/fleet.js");
const { ensureClient } = await import("../apps/main/src/service.js");

// 1. Parser: valid in, everything else warned-off, nothing executes here.
const reply = `On it.\n\`\`\`dispatch {"task": "Run ls and report 3 entries", "agent": "build"}\`\`\`\n\`\`\`dispatch {"task": "Review shell.js"}\`\`\``;
const p = parseDispatches(reply);
if (p.dispatches.length !== 2) throw new Error("two fences missed");
if (p.dispatches[0].agent !== "build" || p.dispatches[1].agent !== null) throw new Error("agent parse wrong");
const bad = parseDispatches([
  '```dispatch {"task": "x", "shell": "rm -rf"}```',
  '```dispatch not-json```',
  '```dispatch {"task": ""}```',
  '```dispatch {"task": "x", "agent": "BAD ID!"}```',
  '```dispatch {"task": "line1\nline2"}```',
].join("\n"));
if (bad.dispatches.length !== 0 || bad.warnings.length !== 4) {
  throw new Error(`bad fences leaked: ${bad.dispatches.length} parsed, ${bad.warnings.length} warnings`);
}
if (parseDispatches("plain words, no fence").dispatches.length !== 0) throw new Error("prose parsed");
console.log("parse-ok: valid parsed, 4 malformed warned-off, multiline stays prose");

// 2. Strip + stream filter keep the transcript clean.
const stripped = stripDispatches(reply);
if (stripped.includes("dispatch") || !stripped.includes("On it.")) throw new Error("strip wrong");
let forwarded = "";
const f = fencedFilter((d) => { forwarded += d; });
const fence = '```dispatch {"task": "Run ls"}```';
for (const chunk of ["On it\n", fence.slice(0, 20), fence.slice(20) + "\nDone\n", "tail"]) {
  f.push(chunk);
}
f.flush();
if (forwarded.includes("dispatch") || !forwarded.includes("On it") || !forwarded.includes("Done") || !forwarded.endsWith("tail")) {
  throw new Error(`filter leaked: ${JSON.stringify(forwarded)}`);
}
console.log("stream-ok: split fence held back, prose intact");

// 3. Prompt carries the convention + fleet (or the no-fleet line).
const pr = buildThinkPrompt("hi", [], [{ id: "reviewer", description: "read-only review" }]);
if (!pr.includes("reviewer") || !pr.includes("```dispatch")) throw new Error("prompt missing convention/fleet");
const prEmpty = buildThinkPrompt("hi", [], []);
if (!/no fleet agents/i.test(prEmpty)) throw new Error("empty-fleet line missing");
console.log("prompt-ok: convention + registry grounded");

// 4. Live: plain turn emits no dispatches (no false positives).
const r = await brainRespond("Reply with exactly: act-ok. No tools.", () => {});
if (r.status !== "ok" || (r.dispatches ?? []).length !== 0) throw new Error("false-positive dispatch");
console.log(`live-ok: plain turn clean via ${r.modelUsed?.providerID}/${r.modelUsed?.id}`);

// 5. Live chain: canned fence -> resolve -> spawn -> done -> delete.
const { client } = await ensureClient();
const registry = await getFleetRegistry(client, process.cwd());
const want = parseDispatches('```dispatch {"task": "Reply with exactly: chain-ok. No tools."}```').dispatches[0];
const res = resolveAgent(want.task, { explicit: null, defaultAgent: "build", autoMode: "off", registry });
if (res.agent !== "build") throw new Error(`resolve wrong: ${res.agent}`);
const w = await spawnWorker(want.task, { agent: res.agent });
const end = await waitWorker(client, w.sessionID);
await deleteWorker(w.sessionID).catch(() => {});
if (end !== "ok") throw new Error(`chained worker ${end}`);
console.log("chain-ok: fence -> resolve -> worker done -> deleted");

// 6. Live delegation: Luna itself emits the fence, which executes end to end.
const { brainRespond: brainLuna, setBrainModel } = await import("../apps/main/src/brain/brain.js");
await setBrainModel("opencode-go", "gpt-6-luna");
let lr = null;
let lunaStream = "";
for (let attempt = 1; attempt <= 2; attempt++) {
  let attemptStream = "";
  lr = await brainLuna("Run the shell command `echo delegate-probe-123` and tell me the result. No file edits.", (d) => { attemptStream += d; });
  if (lr.status === "ok" && lr.dispatches.length === 1) { lunaStream = attemptStream; break; }
  console.log(`delegate-retry: attempt ${attempt} produced ${lr.dispatches.length} fences`);
}
if (!lr || lr.status !== "ok" || lr.dispatches.length !== 1) {
  throw new Error(`luna did not delegate: ${JSON.stringify(lr?.dispatches)}`);
}
if (lunaStream.includes("dispatch")) throw new Error("fence leaked into stream");
const lres = resolveAgent(lr.dispatches[0].task, {
  explicit: lr.dispatches[0].agent, defaultAgent: "build", autoMode: "off", registry,
});
if (lres.error) throw new Error(`luna agent refused: ${lres.error}`);
const lw = await spawnWorker(lr.dispatches[0].task, { agent: lres.agent });
const lend = await waitWorker(client, lw.sessionID);
await deleteWorker(lw.sessionID).catch(() => {});
if (lend !== "ok") throw new Error(`delegated worker ${lend}`);
console.log(`delegate-ok: luna fenced agent=${lres.agent}, worker done -> deleted`);
console.log("brain-act-ok");
process.exit(0);

async function waitWorker(c, sessionID, ms = 120000) {
  const sub = c.event.subscribe();
  try {
    return await new Promise((resolve) => {
      const to = setTimeout(() => resolve("timeout"), ms);
      (async () => {
        for await (const ev of sub) {
          const d = ev.data ?? {};
          if (d.sessionID !== sessionID) continue;
          if (ev.type === "session.execution.succeeded") { clearTimeout(to); resolve("ok"); break; }
          if (ev.type === "session.execution.failed") { clearTimeout(to); resolve("failed"); break; }
        }
      })();
    });
  } finally {
    if (typeof sub.return === "function") await sub.return(undefined).catch(() => {});
  }
}
