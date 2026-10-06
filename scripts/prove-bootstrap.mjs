// Bootstrap slice proof: pure stage machine + ONE live file create/verify/remove.
// No model call anywhere: live step is file write + agent.list/agent.get + cleanup,
// mirroring scripts/prove-config.mjs. No stray files after.
import fs from "node:fs";
import path from "node:path";
process.env.WORKER_MODEL ??= "opencode/fledge-alpha-free";
const boot = await import("../apps/main/src/bootstrap.js");
const { removeAgentFile } = await import("../apps/main/src/config.js");
const { ensureClient } = await import("../apps/main/src/service.js");

const assert = (c, m) => { if (!c) throw new Error(`prove-bootstrap FAIL: ${m}`); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`prove-bootstrap FAIL: ${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };

if (JSON.stringify(boot.BUILTINS) !== JSON.stringify(["build", "plan", "general", "explore", "scout", "compaction", "title", "summary"])) {
  throw new Error("prove-bootstrap FAIL: BUILTINS drifted");
}
eq(boot.EFFORTS, { low: { steps: 5 }, medium: { steps: 15 }, high: { steps: 30 } }, "EFFORTS");
console.log("consts-ok: BUILTINS + EFFORTS match spec");

// ---- pure stage machine ----
const ctx = {
  providers: ["openrouter", "anthropic"],
  modelsByProvider: { openrouter: ["x/y:free", "x/z:free"], anthropic: ["claude-1"] },
};

const c0 = boot.startCreate([]);
assert(c0.stage === "purpose" && typeof c0.prompt === "string" && /what is the agent for/i.test(c0.prompt), "startCreate purpose+prompt");
assert(boot.pendingBootstraps.has(c0.id), "startCreate stores conv");

let s = await boot.answerCreate(c0, "cancel", ctx);
eq(s.stage, "cancelled", "cancel at purpose");
assert(!boot.pendingBootstraps.has(c0.id), "cancel drops conv");
console.log("cancel-ok: cancel at purpose -> cancelled + map cleaned");

const c1 = boot.startCreate([]);
s = await boot.answerCreate(c1, "!!!", ctx);
eq(s.stage, "purpose", "unsluggable purpose re-asks");
s = await boot.answerCreate(c1, "API Tester Probe", ctx);
eq(s.stage, "provider", "purpose -> provider");
eq(s.options, ["openrouter", "anthropic"], "provider options");
assert(c1.name === "api-tester-probe", `slug from purpose, got ${c1.name}`);

s = await boot.answerCreate(c1, "nope-provider", ctx);
eq(s.stage, "provider", "bad provider rejected");
s = await boot.answerCreate(c1, "OpenRouter", ctx);
eq(s.stage, "model", "provider -> model (case-insensitive)");
eq(s.options, ["x/y:free", "x/z:free"], "model options for provider");

s = await boot.answerCreate(c1, "nope-model", ctx);
eq(s.stage, "model", "bad model rejected");
s = await boot.answerCreate(c1, "X/Y:free", ctx);
eq(s.stage, "effort", "model -> effort (case-insensitive)");
eq(s.options, ["low", "medium", "high"], "effort options");

s = await boot.answerCreate(c1, "huge", ctx);
eq(s.stage, "effort", "bad effort rejected");
s = await boot.answerCreate(c1, "medium", ctx);
eq(s.stage, "confirm", "effort -> confirm");
eq(s.spec, { name: "api-tester-probe", provider: "openrouter", model: "x/y:free", effort: "medium", permissions: { edit: "ask", bash: "ask" } }, "confirm shows exact spec");
console.log("machine-ok: purpose->provider->model->effort->confirm, bad inputs rejected");

s = await boot.answerCreate(c1, "maybe-later", ctx);
eq(s.stage, "confirm", "non-answer at confirm re-shows spec");
s = await boot.answerCreate(c1, "no", ctx);
eq(s.stage, "cancelled", "no at confirm cancels");
assert(!boot.pendingBootstraps.has(c1.id), "confirm-no drops conv");
console.log("confirm-ok: exact spec shown; no -> cancelled");

// ---- gate both branches with stub clients (no server) ----
const stubClient = (agents) => ({ agent: { list: async () => ({ data: agents }) } });
const onlyBuiltins = boot.BUILTINS.map((id) => ({ id, description: "b", mode: "primary" }));
const gEmpty = await boot.ensureFleetOrAsk(stubClient(onlyBuiltins), "/tmp");
assert(gEmpty.state === "empty" && /no agent/i.test(gEmpty.prompt) && /yes\/no/.test(gEmpty.prompt), "empty fleet asks yes/no");
const gReady = await boot.ensureFleetOrAsk(stubClient([...onlyBuiltins, { id: "probe-x", description: "d", mode: "subagent" }]), "/tmp");
assert(gReady.state === "ready" && gReady.agents.length === 1 && gReady.agents[0].id === "probe-x", "ready filters builtins");
console.log("gate-pure-ok: empty asks yes/no, ready carries only custom agents");

// ---- live: ONE create/verify/remove, no model call ----
const DIR = process.cwd();
const { client } = await ensureClient();

const gate = await boot.ensureFleetOrAsk(client, DIR);
assert(gate.state === "ready" || gate.state === "empty", "gate state");
if (gate.state === "ready") assert(Array.isArray(gate.agents), "ready carries agents");
else assert(/no agent/i.test(gate.prompt) && /yes\/no/.test(gate.prompt), "empty prompt asks yes/no");
console.log(`gate-ok: ensureFleetOrAsk -> ${gate.state}`);

const providers = await boot.listProviders(client);
assert(Array.isArray(providers) && providers.length > 0, "listProviders non-empty");
let liveProvider = null;
let liveModels = [];
for (const p of providers) {
  const ms = await boot.listModelsFor(client, p);
  if (ms.length > 0) { liveProvider = p; liveModels = ms; break; }
}
assert(liveProvider, "at least one provider has models");
console.log(`models-ok: ${providers.length} providers, using ${liveProvider}/${liveModels[0]}`);

const purpose = `Bootstrap probe ${Date.now().toString(36)}`;
const c2 = boot.startCreate([]);
const liveCtx = { providers, modelsByProvider: { [liveProvider]: liveModels }, client, directory: DIR };
let r = await boot.answerCreate(c2, purpose, liveCtx);
assert(r.stage === "provider", "live purpose -> provider");
r = await boot.answerCreate(c2, liveProvider, liveCtx);
assert(r.stage === "model", "live provider -> model");
r = await boot.answerCreate(c2, liveModels[0], liveCtx);
assert(r.stage === "effort", "live model -> effort");
r = await boot.answerCreate(c2, "low", liveCtx);
assert(r.stage === "confirm" && r.spec.name === c2.name, "live effort -> confirm");
r = await boot.answerCreate(c2, "yes", liveCtx);
assert(r.stage === "done" && r.name === c2.name, "live confirm yes -> done");
assert(!boot.pendingBootstraps.has(c2.id), "done drops conv");
console.log(`create-ok: ${r.note}`);

const fleet = await boot.getFleetAgents(client, DIR);
assert(fleet.some((a) => a.id === c2.name), "probe visible in custom fleet");
assert(!fleet.some((a) => boot.BUILTINS.includes(a.id)), "builtins filtered from fleet");
const got = await client.agent.get({ agentID: c2.name, location: { directory: DIR } });
assert((got.data ?? {}).mode === "subagent", "probe mode subagent");
console.log("verify-ok: probe in agent.list + agent.get, builtins filtered");

const removed = await removeAgentFile(client, DIR, c2.name);
assert(removed.removed, "probe removal reflected in agent list");
const file = path.join(DIR, ".opencode", "agents", `${c2.name}.md`);
assert(!fs.existsSync(file), "probe file gone");
assert(boot.pendingBootstraps.size === 0, "no pending convs left");
console.log("cleanup-ok: probe file + list entry gone, no pending convs");
console.log("bootstrap-ok");
process.exit(0);
