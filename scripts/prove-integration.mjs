// Integration: voice gate + bootstrap machine + auto routing against the wiring.
// Pure where possible; live only for temp-dir bootstrap create and registry read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { hasWake, stripWake, isVoiceMode, nextVoiceAction } = await import("../apps/main/src/voice.js");
const { startCreate, answerCreate, ensureFleetOrAsk, pendingBootstraps } = await import("../apps/main/src/bootstrap.js");
const { parseExplicitAgent, pickAgent, resolveAgent, getFleetRegistry } = await import("../apps/main/src/autoroute.js");
const { ensureClient } = await import("../apps/main/src/service.js");

// 1. Voice gate (pure).
if (!hasWake("hey jarvis, dim the fleet", "jarvis")) throw new Error("wake missed");
if (hasWake("no wake here", "jarvis")) throw new Error("wake leak");
if (stripWake("hey jarvis, dim the fleet", "jarvis") !== "dim the fleet") throw new Error("strip missed");
if (nextVoiceAction("hey jarvis, hi", { voiceMode: "on", wakeWord: "jarvis" }).action !== "wake-task") throw new Error("gate missed");
if (nextVoiceAction("hey jarvis, hi", { voiceMode: "off", wakeWord: "jarvis" }).action !== "ignored") throw new Error("off leak");
console.log("voice-ok");

// 2. Bootstrap machine (pure stages) with stub providers.
const conv = startCreate([]);
let r = await answerCreate(conv, "api tester", { providers: ["opencode"], modelsByProvider: { opencode: ["fledge-alpha-free"] } });
if (r.stage !== "provider") throw new Error("purpose stage missed");
r = await answerCreate(conv, "opencode", { providers: ["opencode"], modelsByProvider: { opencode: ["fledge-alpha-free"] } });
if (r.stage !== "model") throw new Error("provider stage missed");
r = await answerCreate(conv, "fledge-alpha-free", { providers: ["opencode"], modelsByProvider: { opencode: ["fledge-alpha-free"] } });
if (r.stage !== "effort") throw new Error("model stage missed");
r = await answerCreate(conv, "medium", {});
if (r.stage !== "confirm" || !r.spec || r.spec.effort !== "medium") throw new Error("effort/confirm missed");
r = await answerCreate(startCreate([]), "no", {});
if (r.stage !== "cancelled") throw new Error("cancel missed");
for (const id of [...pendingBootstraps.keys()]) pendingBootstraps.delete(id);
console.log("machine-ok");

// 3. Bootstrap live: temp dir has no fleet -> empty; create -> verify -> cleanup.
const { client } = await ensureClient();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-boot-"));
const gate = await ensureFleetOrAsk(client, tmp);
if (gate.state !== "empty" || !/no agent/i.test(gate.prompt)) throw new Error(`gate missed: ${JSON.stringify(gate)}`);
console.log("gate-ok: temp dir fleet is empty");
const c2 = startCreate([]);
const ctx = { providers: ["opencode"], modelsByProvider: { opencode: ["fledge-alpha-free"] }, client, directory: tmp };
await answerCreate(c2, "probe agent", ctx);
await answerCreate(c2, "opencode", ctx);
await answerCreate(c2, "fledge-alpha-free", ctx);
await answerCreate(c2, "low", ctx);
const done = await answerCreate(c2, "yes", ctx);
if (done.stage !== "done" || !done.name) throw new Error("live create missed");
const listed = await client.agent.list({ location: { directory: tmp } });
if (!(listed.data ?? []).some((a) => a.id === done.name)) throw new Error("created agent not listed");
console.log(`create-ok: ${done.name} verified in agent list`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("cleanup-ok: temp dir removed");

// 4. Auto routing (pure) + live registry read.
if (parseExplicitAgent("@reviewer check auth")?.agent !== "reviewer") throw new Error("explicit missed");
if (parseExplicitAgent("review the auth module") !== null) throw new Error("explicit leak");
const reg = [{ id: "reviewer", description: "read-only code review" }, { id: "tester", description: "api testing" }];
if (pickAgent("review the auth module", reg, "build").agent !== "reviewer") throw new Error("pick missed");
if (resolveAgent("hi", { defaultAgent: "build", autoMode: "off", registry: reg }).agent !== "build") throw new Error("default missed");
if (!resolveAgent("x", { explicit: "ghost", defaultAgent: "build", autoMode: "off", registry: reg }).error) throw new Error("unknown accepted");
const live = await getFleetRegistry(client, process.cwd());
if (!Array.isArray(live)) throw new Error("registry not an array");
console.log(`route-ok: pure resolve + live registry (${live.length} custom)`);
console.log("integration-ok");
process.exit(0);
