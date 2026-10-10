import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClient } from "./service.js";
import { promptJarvis, ensureJarvisSession } from "./sessions.js";
import { listenOnce, toUtterance, isListening, stopListening } from "./audio.js";
import { ensureFleetPump, spawnWorker, followUpWorker, rehydrateWorkers, workers, latestSettledChain, chainBusy, stopWorker, deleteWorker, replyPermission, latestActiveWorker, snapshot, pendingPermissions, routeUtterance, listSessions, renameSession, forkSession, switchSessionAgent, switchSessionModel, listAgents, listModels, listCommands, listSkills, getDiff, listMessages, undoMessage, cleanupWorkers, listProjects, projectIDFor, listWorktrees, createWorktree, removeWorktree, compactSession } from "./fleet.js";
import { loadStore, applyAppCommand, validateAppCommand, ACCENTS, VOICES, VOICE_LABELS, FOLLOW_UPS } from "./shell.js";
import { stateBlock, resolveRef } from "./actions.js";
import { brainRespond, brainReview, setBrainModel, needsWorkerFallback } from "./brain/brain.js";
import { collectWorkerReport, reportHeadline } from "./brain/report.js";
import { chains, loadChains, createChainWorktree, bindChain, landChain, keepChain, discardChain } from "./worktrees.js";
import { applyAgentFile, stageWidening, confirmWidening, pendingConfigs } from "./config.js";
import { termStart, termOutput, termKill, ptyOpen, ptyResize, ptyClose, ptyAttach, ptyWrite, ptyDetach, ptyDetachAll } from "./terminal.js";
import { pendingForms, refreshForms, replyForm, matchFormAnswer, formsFor } from "./forms.js";
import { isVoiceMode, nextVoiceAction, stripWake, createConversation, followUpMs } from "./voice.js";
import { speechFor, voiceGate, isHush, permissionLine } from "./speech.js";
import { synthesize, warmVoice, stopVoice, hasNeuralVoice } from "./tts.js";
import { ensureFleetOrAsk, startCreate, startCreateWithPurpose, answerCreate, pendingBootstraps } from "./bootstrap.js";
import { loadMemory, loadProjectMemory, remember as rememberFact, forget as forgetFact, matchFacts } from "./brain/memory.js";
import { parseExplicitAgent, resolveAgent, getFleetRegistry } from "./autoroute.js";
import { projectDir, projectName, recentProjects, setProject, matchProjectCommand } from "./project.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bootStash = new Map(); // bootID -> { task, directory, gate, conv?, ctx? }
const latestBootstrap = () => [...bootStash.keys()].pop() ?? null;

let shell = null;
const shellStore = () => (shell ??= loadStore());

const latestConfigPending = () => [...pendingConfigs.keys()].pop() ?? null;
const publicPending = (s) => ({ pendingID: s.pendingID, kind: s.kind, summary: s.summary, rule: { action: s.action, resources: s.resources, effect: s.effect } });
const withDeleteTarget = (spec) => ({ ...spec, target: latestActiveWorker()?.sessionID ?? null });
const widenHooks = () => ({
  jarvisSessionID: async () => ensureJarvisSession(projectDir()),
  resolveTarget: async (staged) => staged.target ?? latestActiveWorker()?.sessionID ?? null,
  deleteTarget: async (id) => deleteWorker(id),
});
function configAudit(kind, r) {
  return {
    at: Date.now(),
    bucket: "server-config",
    what: r.summary ?? `${kind} ${r.name ?? r.target ?? ""}`.trim(),
    live: r.needsRestart !== true,
    needsRestart: r.needsRestart === true,
    note: r.note ?? (r.applied === false ? "discarded, nothing written" : "server reloaded"),
  };
}
function broadcastConfig(r) {
  const entry = configAudit(r.summary?.startsWith("Allow") ? "permission-allow-rule" : "config", r);
  broadcast({ kind: r.applied === false ? "config.discarded" : "config.applied", entry, ...r });
}


async function answerPending(decision) {
  const [requestID] = [...pendingPermissions.keys()];
  const r = await replyPermission(requestID, decision);
  return { requestID, decision, r };
}

// Spoken replies (voice mode only). Main renders the line in Jarvis's one
// fixed voice (tts.js); the deck plays it and reports when it is talking, so
// the voice loop can ignore Jarvis's own voice.
let speakingNow = false;
let speakingTailUntil = 0;
const isSpeaking = () => speakingNow || Date.now() < speakingTailUntil;
function setSpeaking(on) {
  speakingNow = !!on;
  if (!on) speakingTailUntil = Date.now() + 700;
  // Jarvis talking keeps the conversation open; the countdown starts when it stops.
  if (on) convo.hold("speaking");
  else convo.release("speaking", followUpMs(shellStore().settings.followUp));
  paintConversation();
  // The loop's current listen has been hearing Jarvis; once it stops, start a
  // fresh one so a follow-up never begins with Jarvis's own words.
  if (!on && loopListening) {
    setTimeout(() => { if (loopListening && !speakingNow) stopListening(); }, 250);
  }
}
let loopListening = false;

// Conversation window: "hey jarvis" once, then just talk. Stays open while
// Jarvis thinks or speaks and for settings.followUp seconds after.
const convo = createConversation();
let convoTimer = null;
let convoWin = null;
let convoShown = null;
function paintConversation(win = convoWin) {
  convoWin = win ?? convoWin;
  clearTimeout(convoTimer);
  const ms = convo.remainingMs();
  const open = ms > 0;
  if (open !== convoShown) {
    convoShown = open;
    convoWin?.webContents.send("voice.conversation", { open });
  }
  if (open && Number.isFinite(ms)) convoTimer = setTimeout(() => paintConversation(), ms + 50);
}
let speakToken = 0;
async function speak(win, text) {
  const t = String(text ?? "").trim();
  if (!t || !isVoiceMode(shellStore())) return;
  const my = ++speakToken;
  const voice = shellStore().settings.voice;
  let rendered = null;
  try {
    rendered = await synthesize(t, voice);
  } catch (err) {
    console.warn(`[voice] ${err.message ?? err}; deck falls back to the system voice`);
  }
  // A hush, a newer line or voice-off while rendering wins.
  if (my !== speakToken || !isVoiceMode(shellStore())) return;
  win?.webContents.send("jarvis.speak", { text: t, voice, audio: rendered?.audio ?? null, ms: rendered?.ms ?? 0 });
}
function hush(win) {
  speakToken++;
  win?.webContents.send("jarvis.speak.stop", {});
}
// Keep the voice model warm while voice mode is on; re-warm on a voice change.
function onVoiceSettings(name, value) {
  const s = shellStore().settings;
  if (name === "set.voice" && s.voiceMode === "on") warmVoice(value)?.catch(() => {});
  if (name === "set.voiceMode") {
    if (value === "on") warmVoice(s.voice)?.catch(() => {});
    else stopVoice();
  }
}

// A worker needs approval: in voice mode Jarvis says what it wants and keeps
// listening, so a plain "yes" / "no" answers it (the card works too). The
// conversation stays open until every pending request is answered.
function askPermissionAloud(request) {
  if (!isVoiceMode(shellStore())) return;
  const agent = workers.get(request?.sessionID)?.agent ?? "";
  convo.open(Math.max(followUpMs(shellStore().settings.followUp), 60000));
  convo.hold("permission");
  paintConversation(win);
  speak(win, permissionLine(request, agent));
}
function permissionSettled() {
  if (pendingPermissions.size > 0) return;
  const followUp = followUpMs(shellStore().settings.followUp);
  convo.release("permission", followUp);
  if (!followUp) convo.close();
  paintConversation(win);
}

// Voice loop: mic stays open while shell voiceMode is on. Wake-gated tasks feed
// the same commitText as typed text; push-to-talk keeps working via suspend.
let voiceRunning = false;
let voiceSuspend = false;
async function voiceLoop(commitText, win) {
  if (voiceRunning) return;
  voiceRunning = true;
  let failures = 0;
  try {
    while (isVoiceMode(shellStore())) {
      if (voiceSuspend || isListening()) { await sleep(500); continue; }
      let fin;
      try {
        loopListening = true;
        fin = await listenOnce({ onPartial: (p) => win?.webContents.send("caption.partial", p) });
        failures = 0;
      } catch (err) {
        // Nobody spoke for a whole listen window, or the listen was restarted: listen again.
        if (/^listen (timeout|stopped)$/.test(String(err.message ?? err))) continue;
        // Back off on repeated spawn failures (e.g. mic denied) instead of hot-looping.
        failures += 1;
        win?.webContents.send("audio.error", { message: String(err.message ?? err) });
        await sleep(Math.min(30000, 1500 * 2 ** Math.min(failures, 4)));
        continue;
      } finally {
        loopListening = false;
      }
      const s = shellStore().settings;
      // While Jarvis talks the mic hears it too: drop that, but let an
      // explicit "hey jarvis …" cut in (and "hey jarvis stop" just hushes).
      const gate = voiceGate(fin.text, { speaking: isSpeaking(), wakeWord: s.wake });
      if (gate === "drop") continue;
      if (gate === "barge") {
        hush(win);
        if (isHush(stripWake(fin.text, s.wake))) continue;
      }
      const followUp = followUpMs(s.followUp);
      const answering = pendingPermissions.size > 0 || pendingConfigs.size > 0;
      const next = nextVoiceAction(fin.text, { voiceMode: s.voiceMode, wakeWord: s.wake, inConversation: convo.isOpen(), answering });
      if (next.action === "wake-task" || next.action === "follow-up") {
        if (next.action === "wake-task") convo.open(followUp);
        const utterance = toUtterance(fin);
        win?.webContents.send("caption.final", { id: utterance.id, text: utterance.text });
        convo.hold("turn");
        paintConversation(win);
        try { await commitText(next.text); } catch (err) { console.error("voice commit failed:", err.message ?? err); }
        finally {
          convo.release("turn", followUp);
          paintConversation(win);
          win?.webContents.send("utterance.settled", { id: utterance.id });
        }
      } else if (next.action === "wake-empty") {
        const opened = convo.open(followUp);
        paintConversation(win);
        win?.webContents.send("caption.partial", { id: fin.id, text: opened ? "go ahead, I'm listening" : `heard ${s.wake} — say a command`, revision: 0 });
        if (opened) speak(win, "Yes?");
      } else if (next.action === "dismiss") {
        convo.close();
        paintConversation(win);
        speak(win, `Okay. Say hey ${s.wake} when you need me.`);
      } else if (next.action === "ack") {
        convo.touch(followUp);
        paintConversation(win);
      }
    }
  } finally {
    voiceRunning = false;
  }
}

// "Clean up the completed and failed workers": Jarvis's own housekeeping, done
// here (no worker, no model). Running or waiting workers are never touched.
async function runFleetCleanup(states, { quiet = false } = {}) {
  const r = await cleanupWorkers(states);
  win?.webContents.send("fleet.state", { kind: "fleet.state", snapshot: snapshot() });
  const kinds = states.map((s) => ({ done: "completed", failed: "failed", stopped: "stopped" }[s])).join(" or ");
  const n = r.removed.length;
  const line = n ? `Removed ${n} ${kinds} worker${n === 1 ? "" : "s"}.` : `There are no ${kinds} workers to clean up.`;
  win?.webContents.send("session.stream", { delta: `\n[fleet] ${line}${r.errors.length ? ` Failed: ${r.errors.join("; ")}` : ""}\n` });
  if (!quiet) speak(win, line);
  return { ...r, line };
}

let commitTextRef = null; // set once the IPC layer defines commitText

// What the brain is shown about the deck each turn (actions.js stateBlock).
function jarvisContext() {
  try {
    return stateBlock({
      workers: snapshot().map((w) => ({ ...w, sessionID: w.id })),
      chains: [...chains.values()],
      settings: shellStore().settings,
      projects: recentProjects(),
      pendingPermissions: pendingPermissions.size,
    });
  } catch (err) {
    return `(deck state unavailable: ${String(err.message ?? err).slice(0, 80)})`;
  }
}

// Execute one validated ```jarvis``` action from the brain. The brain only
// asks; everything is checked again here, and the outcome is written to the
// transcript (and spoken if it failed, since the brain already said "done").
async function runJarvisAction(a, broadcast) {
  const note = (line) => win?.webContents.send("session.stream", { delta: `\n[jarvis] ${line}\n` });
  const fail = (why) => {
    note(`couldn't ${a.action}: ${why}`);
    speak(win, `Sorry, I couldn't do that: ${why}.`);
    return { ok: false, reason: why };
  };
  const worker = () => resolveRef(a.worker, workers.keys());
  try {
    switch (a.action) {
      case "set": {
        const name = `set.${a.setting}`;
        if (name === "set.jarvisModel") {
          const slash = a.value.indexOf("/");
          if (slash < 0) return fail("a model is provider/id");
          await setBrainModel(a.value.slice(0, slash), a.value.slice(slash + 1));
        }
        const entry = applyAppCommand(shellStore(), name, { value: a.value });
        broadcast({ kind: "settings.applied", entry, settings: shellStore().settings });
        onVoiceSettings(name, a.value);
        if (name === "set.voiceMode") {
          if (a.value === "on" && commitTextRef) voiceLoop(commitTextRef, win);
          else { stopListening(); hush(win); convo.close(); paintConversation(win); }
        }
        note(`${a.setting} → ${a.value}`);
        return { ok: true };
      }
      case "cleanup":
        return { ok: true, ...(await runFleetCleanup(a.states, { quiet: true })) };
      case "stop": {
        const id = worker();
        if (!id) return fail(`no single worker matches ${a.worker}`);
        await stopWorker(id);
        broadcast({ kind: "fleet.state", snapshot: snapshot() });
        note(`stopped worker ${id.slice(0, 8)}`);
        return { ok: true };
      }
      case "remove": {
        const id = worker();
        if (!id) return fail(`no single worker matches ${a.worker}`);
        if (["working", "permission"].includes(workers.get(id)?.state)) return fail("that worker is still running; stop it first");
        await deleteWorker(id);
        broadcast({ kind: "fleet.state", snapshot: snapshot() });
        note(`removed worker ${id.slice(0, 8)}`);
        return { ok: true };
      }
      case "followup": {
        const id = worker();
        if (!id) return fail(`no single worker matches ${a.worker}`);
        if (["working", "permission"].includes(workers.get(id)?.state)) return fail("that worker is still busy");
        await followUpWorker(id, a.task);
        broadcast({ kind: "fleet.state", snapshot: snapshot() });
        note(`follow-up → ${id.slice(0, 8)}: ${a.task.slice(0, 80)}`);
        return { ok: true };
      }
      case "land":
      case "keep":
      case "discard": {
        const chainID = a.chain ? resolveRef(a.chain, chains.keys()) : null;
        if (a.chain && !chainID) return fail(`no single branch matches ${a.chain}`);
        const r = await chainAction(a.action, chainID, broadcast);
        if (!r.ok) return fail(r.reason);
        note({ land: `landed ${r.branch} into ${r.base}`, keep: `kept branch ${r.branch}`, discard: `discarded ${r.branch}` }[a.action]);
        return r;
      }
      case "project": {
        const want = a.name.toLowerCase();
        const hits = recentProjects().filter((p) => p.name.toLowerCase() === want || p.dir === a.name);
        const loose = hits.length ? hits : recentProjects().filter((p) => p.name.toLowerCase().includes(want));
        if (loose.length !== 1) return fail(loose.length ? `"${a.name}" matches several projects` : `no recent project called ${a.name}`);
        await switchProject(loose[0].dir, broadcast);
        note(`now working in ${loose[0].name}`);
        return { ok: true };
      }
      case "hush":
        hush(win);
        return { ok: true };
      case "remember": {
        const mem = a.scope === "project" ? loadProjectMemory() : loadMemory();
        const f = rememberFact(mem, a.fact, ["asked"]);
        note(f ? `remembered${a.scope === "project" ? " for this project" : ""}: ${a.fact}` : `already remembered: ${a.fact}`);
        return { ok: true };
      }
      case "forget": {
        const mem = a.scope === "project" ? loadProjectMemory() : loadMemory();
        const hits = matchFacts(mem, a.fact);
        if (!hits.length) return fail(`nothing remembered matches "${a.fact}"`);
        if (hits.length > 1) return fail(`${hits.length} memories match "${a.fact}"; be more specific`);
        forgetFact(mem, hits[0].id);
        note(`forgot: ${hits[0].text}`);
        return { ok: true };
      }
      case "agent": {
        const directory = projectDir();
        const ctx = await buildBootstrapCtx(directory);
        const id = `boot_${Date.now().toString(36)}`;
        const first = await startCreateWithPurpose(a.purpose, ctx, [], a.name);
        if (first.stage === "purpose") return fail(first.prompt);
        bootStash.set(id, { task: null, directory, gate: false, conv: first.conv, ctx });
        broadcast({ kind: "bootstrap.ask", id, stage: first.stage, prompt: first.prompt, options: first.options });
        note(`creating agent ${first.conv.name}: answer on the card`);
        return { ok: true };
      }
    }
    return fail("unknown action");
  } catch (err) {
    return fail(String(err.message ?? err).slice(0, 120));
  }
}

async function buildBootstrapCtx(directory) {
  const { client } = await ensureClient();
  const list = await client.model.list();
  const rows = list.models ?? list.data ?? [];
  const arr = Array.isArray(rows) ? rows : [];
  const providers = [...new Set(arr.map((m) => m.providerID).filter(Boolean))];
  const modelsByProvider = {};
  for (const m of arr) {
    if (!m.providerID) continue;
    (modelsByProvider[m.providerID] ??= []).push(m.modelID ?? m.id);
  }
  return { client, directory, providers, modelsByProvider };
}

async function dispatchTask(task, { agent, directory, chain, round } = {}, broadcast) {
  const dir = directory ?? projectDir();
  const { client } = await ensureClient();
  const said = agent ? { agent, task } : parseExplicitAgent(task);
  const cleanTask = said?.task ?? task;
  const settings = shellStore().settings;
  const registry = await getFleetRegistry(client, dir);
  const r = resolveAgent(cleanTask, {
    explicit: said, defaultAgent: settings.defaultAgent ?? "build", autoMode: settings.autoMode, registry,
  });
  if (r.error) return { ok: false, reason: r.error };
  if (!agent && !said) {
    const gate = await ensureFleetOrAsk(client, dir);
    if (gate.state === "empty") {
      const id = `boot_${Date.now().toString(36)}`;
      bootStash.set(id, { task: cleanTask, directory: dir, gate: true });
      broadcast({ kind: "bootstrap.ask", id, stage: "gate", prompt: gate.prompt, options: ["yes", "no"] });
      return { ok: true, needBootstrap: true, id };
    }
  }
  // Isolation: a chain continues in its own worktree; a new chain gets one
  // unless the user chose shared mode or the directory is not a git repo.
  let workDir = dir;
  let fresh = null;
  const open = chain ? chains.get(chain) : null;
  if (open?.state === "open") workDir = open.directory;
  else if (!chain && settings.isolation !== "shared") {
    fresh = await createChainWorktree(dir, cleanTask).catch((err) => {
      console.error("worktree create failed, using shared checkout:", err?.message ?? err);
      return null;
    });
    if (fresh) workDir = fresh.directory;
  }
  const res = await spawnWorker(cleanTask, { agent: agent ?? r.agent, directory: workDir, project: dir, chain, round });
  if (fresh) bindChain(res.sessionID, fresh);
  broadcast({ kind: "fleet.state", snapshot: snapshot() });
  return { ok: true, ...res, agent: agent ?? r.agent, branch: fresh?.branch ?? open?.branch ?? null, reason: r.reason ?? `default->${agent ?? r.agent}` };
}

async function answerBootstrapText(id, text, win, broadcast) {
  const entry = bootStash.get(id);
  if (!entry) throw new Error(`no pending bootstrap: ${id}`);
  const low = String(text ?? "").trim().toLowerCase();
  if (entry.gate) {
    if (/^(yes|y|create|do it)$/.test(low)) {
      const conv = startCreate([]);
      entry.gate = false;
      entry.conv = conv;
      broadcast({ kind: "bootstrap.ask", id, stage: conv.stage, prompt: conv.prompt });
      return { id, stage: conv.stage, prompt: conv.prompt };
    }
    bootStash.delete(id);
    broadcast({ kind: "bootstrap.cancelled", id });
    return { id, stage: "cancelled" };
  }
  entry.ctx ??= await buildBootstrapCtx(entry.directory);
  const r = await answerCreate(entry.conv, text, entry.ctx);
  if (r.stage === "done") {
    bootStash.delete(id);
    // Created on request without a task (Jarvis "agent" action): nothing to run yet.
    if (!entry.task) {
      broadcast({ kind: "bootstrap.done", id, name: r.name, note: r.note, sessionID: null });
      speak(win, `${r.name} is ready. Give it a task whenever you like.`);
      return { id, stage: "done", name: r.name, sessionID: null };
    }
    const spawned = await spawnWorker(entry.task, { agent: r.name, directory: entry.directory });
    broadcast({ kind: "fleet.state", snapshot: snapshot() });
    broadcast({ kind: "bootstrap.done", id, name: r.name, note: r.note, sessionID: spawned.sessionID });
    return { id, stage: "done", name: r.name, sessionID: spawned.sessionID };
  }
  if (r.stage === "cancelled") {
    bootStash.delete(id);
    broadcast({ kind: "bootstrap.cancelled", id });
    return { id, stage: "cancelled" };
  }
  broadcast({ kind: "bootstrap.ask", id, stage: r.stage, prompt: r.prompt, options: r.options, spec: r.spec });
  return { id, stage: r.stage };
}

function matchPendingForm(text) {
  for (const p of [...pendingForms.values()].reverse()) {
    const answer = matchFormAnswer(p.form, text);
    if (answer) return { formID: p.formID, sessionID: p.sessionID, answer };
  }
  return null;
}

// /name rest runs a slash command, @id invokes a skill. Both are turns, not prompts.
function parseSlash(text) {
  const m = String(text ?? "").trim().match(/^\/([a-z0-9-]+)\s*(.*)$/i);
  if (m) return { kind: "command", name: m[1], rest: m[2] ?? "" };
  const s = String(text ?? "").trim().match(/^@([a-z0-9-]+)\s*(.*)$/i);
  if (s) return { kind: "skill", name: s[1], rest: s[2] ?? "" };
  return null;
}

// Bring a project's Jarvis state up: its worker-parent session (persisted),
// the workers under it, and its open worktree chains.
async function loadProject(dir) {
  const { client } = await ensureClient();
  const parentID = await ensureJarvisSession(dir);
  loadChains(dir);
  const n = await rehydrateWorkers(client, parentID, dir).catch((err) => {
    console.error("rehydrate failed:", err?.message ?? err);
    return 0;
  });
  return { dir, name: projectName(dir), workers: n };
}

function projectInfo() {
  const dir = projectDir();
  return { dir, name: projectName(dir), recent: recentProjects() };
}

async function switchProject(dir, broadcast) {
  const r = setProject(dir);
  if (r.changed) await loadProject(r.dir);
  broadcast({ kind: "project.changed", project: projectInfo() });
  broadcast({ kind: "fleet.state", snapshot: snapshot() });
  return { ok: true, ...r };
}

// Land / keep / discard a chain's worktree. Refuses while any worker in the
// chain is still running, so nothing is merged half-done.
async function chainAction(action, chainID, broadcast) {
  const target = chainID ? { chainID, busy: chainBusy(chainID) } : latestSettledChain();
  if (!target) return { ok: false, reason: "no open worktree to " + action };
  if (target.busy) return { ok: false, reason: "workers in that chain are still running; stop them or wait" };
  const fn = { land: landChain, keep: keepChain, discard: discardChain }[action];
  if (!fn) return { ok: false, reason: `unknown action: ${action}` };
  const r = await fn(target.chainID);
  broadcast({ kind: "fleet.state", snapshot: snapshot() });
  broadcast({ kind: "chain.result", chainID: target.chainID, ...r });
  return { chainID: target.chainID, ...r };
}

// Closed loop: a finished worker reports back to Jarvis, who reviews the
// outcome in the chat and may take one next step (follow up with the same
// worker, or dispatch a specialist). Bounded by MAX_ROUNDS per chain; off with
// "turn review mode off".
async function reviewWorker(ev, broadcast) {
  if (!ev.review || shellStore().settings.reviewMode === "off") return;
  const w = workers.get(ev.sessionID);
  if (!w) return;
  const say = (delta) => win?.webContents.send("session.stream", { delta });
  const { client } = await ensureClient();
  const report = await collectWorkerReport(client, w, { status: ev.status, error: ev.error, worktree: chains.get(w.chain) });
  broadcast({
    kind: "worker.report",
    report: { sessionID: report.sessionID, agent: report.agent, round: report.round, status: report.status, headline: reportHeadline(report), files: report.files, branch: report.worktree?.branch ?? null },
  });
  const r = await brainReview(report, say, { voice: isVoiceMode(shellStore()) });
  win?.webContents.send("session.done", { modelUsed: r.modelUsed, status: r.status });
  if (r.status === "ok") speak(win, r.speak);
  for (const warn of r.warnings ?? []) say(`[review] ${warn}\n`);
  if (r.followup) {
    const f = await followUpWorker(report.sessionID, r.followup.task);
    broadcast({ kind: "fleet.state", snapshot: snapshot() });
    say(`[fleet] follow-up → ${report.agent} (${report.sessionID.slice(0, 8)}) round ${f.round}\n`);
  } else if (r.dispatch) {
    const dr = await dispatchTask(r.dispatch.task, { agent: r.dispatch.agent, directory: report.project ?? undefined, chain: report.chain, round: report.round + 1 }, broadcast);
    if (dr.ok && !dr.needBootstrap) say(`[fleet] ${dr.reason} → ${dr.agent} (${String(dr.sessionID).slice(0, 8)})\n`);
    else if (!dr.ok) say(`[fleet] dispatch refused: ${dr.reason}\n`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: "#060809",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(here, "../../deck/index.html"));
}

app.on("will-quit", () => stopVoice());

app.whenReady().then(async () => {
  if (isVoiceMode(shellStore())) warmVoice(shellStore().settings.voice)?.catch(() => {});
  await ensureClient();
  setProject(projectDir());
  await loadProject(projectDir());
  const broadcast = (msg) => win?.webContents.send(msg.kind, msg);
  await ensureFleetPump((ev) => {
    if (ev.kind === "permission.waiting") {
      broadcast({ kind: "permission.waiting", request: ev.request, snapshot: ev.snapshot });
      askPermissionAloud(ev.request);
    } else if (ev.kind === "permission.resolved") {
      broadcast({ kind: "permission.resolved", ...ev });
      permissionSettled();
    }
    else if (ev.kind === "worker.tool") broadcast({ kind: "session.tool", ...ev });
    else if (ev.kind === "worker.stream") broadcast({ kind: "worker.stream", ...ev });
    else if (ev.kind === "form.waiting") broadcast({ kind: "form.waiting", ...ev });
    else if (ev.kind === "form.resolved") broadcast({ kind: "form.resolved", ...ev });
    else if (ev.kind === "worker.done") {
      broadcast({ kind: "fleet.state", snapshot: ev.snapshot });
      reviewWorker(ev, broadcast).catch((err) => {
        console.error("worker review failed:", err?.message ?? err);
        win?.webContents.send("session.stream", { delta: `[review] failed: ${String(err?.message ?? err).slice(0, 160)}\n` });
      });
    } else if (ev.kind === "fleet.pump") broadcast({ kind: "fleet.pump", state: ev.state, attempt: ev.attempt });
    else broadcast({ kind: "fleet.state", snapshot: ev.snapshot });
  });
  const commitText = async (text, files) => {
    const formMatch = matchPendingForm(text);
    const routed = routeUtterance(text, undefined, undefined, formMatch?.answer ?? null);
    if (routed.route === "permission") {
      const r = await answerPending(routed.decision);
      return { ok: true, control: "permission", ...r };
    }
    if (routed.route === "form.answer" && formMatch) {
      await replyForm(formMatch.sessionID, formMatch.formID, routed.answer);
      broadcast({ kind: "form.resolved", sessionID: formMatch.sessionID });
      return { ok: true, control: "form.answer", ...formMatch };
    }
    if (routed.route === "config.confirm") {
      const r = await confirmWidening(
        (await ensureClient()).client,
        projectDir(),
        latestConfigPending(),
        routed.confirmed,
        widenHooks(),
      );
      broadcastConfig(r);
      return { ok: true, control: "config.confirm", ...r };
    }
    if (routed.route === "config.apply") {
      const r = await applyAgentFile((await ensureClient()).client, projectDir(), routed.spec);
      const entry = configAudit("agent-file", r);
      broadcast({ kind: "config.applied", entry, agent: r.name, note: r.note });
      return { ok: true, control: "config.apply", ...r };
    }
    if (routed.route === "config.stage") {
      const staged = stageWidening(routed.spec.kind === "session-delete" ? withDeleteTarget(routed.spec) : routed.spec);
      broadcast({ kind: "config.pending", pending: publicPending(staged) });
      return { ok: true, control: "config.stage", pendingID: staged.pendingID };
    }
    const bootID = latestBootstrap();
    if (bootID) {
      const r = await answerBootstrapText(bootID, text, win, broadcast);
      return { ok: true, control: "bootstrap", ...r };
    }
    const proj = routed.route === "prompt" ? matchProjectCommand(text) : null;
    if (proj) {
      const r = proj.error ? { ok: false, reason: proj.error } : await switchProject(proj.dir, broadcast);
      win?.webContents.send("session.stream", { delta: r.ok ? `[project] now working in ${r.name} (${r.dir})\n` : `[project] ${r.reason}\n` });
      speak(win, r.ok ? `Now working in ${r.name}.` : `I don't know a recent project by that name.`);
      win?.webContents.send("session.done", { status: r.ok ? "ok" : "failed" });
      return { ok: r.ok, control: "project", ...r };
    }
    if (routed.route === "chain.action") {
      const r = await chainAction(routed.action, null, broadcast);
      const line = r.ok
        ? { land: `landed ${r.branch} into ${r.base}`, keep: `kept branch ${r.branch}; worktree removed`, discard: `discarded ${r.branch}` }[r.action]
        : `${routed.action} refused: ${r.reason}`;
      win?.webContents.send("session.stream", { delta: `[git] ${line}\n` });
      speak(win, r.ok ? { land: "Landed.", keep: "Kept the branch.", discard: "Discarded." }[r.action] : `I couldn't ${routed.action} it. ${r.reason}`);
      win?.webContents.send("session.done", { status: r.ok ? "ok" : "failed" });
      return { ok: r.ok, control: "chain.action", ...r };
    }
    if (routed.route === "fleet.cleanup") {
      const r = await runFleetCleanup(routed.states);
      win?.webContents.send("session.done", { status: "ok" });
      return { ok: true, control: "fleet.cleanup", ...r };
    }
    if (routed.route === "stop-worker") {
      const w = latestActiveWorker();
      if (!w) return { ok: false, control: "stop-worker", reason: "no active worker" };
      await stopWorker(w.sessionID);
      broadcast({ kind: "fleet.state", snapshot: snapshot() });
      return { ok: true, control: "stop-worker", sessionID: w.sessionID };
    }
    if (routed.route === "app.command") {
      // Shell bucket: applied next frame, persisted, no model call.
      const entry = applyAppCommand(shellStore(), routed.name, routed.args);
      broadcast({ kind: "settings.applied", entry, settings: shellStore().settings });
      onVoiceSettings(routed.name, routed.args?.value);
      if (routed.name === "set.voice") speak(win, "This is my voice now.");
      if (routed.name === "set.voiceMode") {
        if (routed.args?.value === "on") voiceLoop(commitText, win);
        else { stopListening(); hush(win); convo.close(); paintConversation(win); }
      }
      return { ok: true, control: "app.command", entry };
    }
    const r = await brainRespond(text, (d) => {
      win?.webContents.send("session.stream", { delta: d });
    }, { voice: isVoiceMode(shellStore()), context: jarvisContext() }).catch(async (err) => {
      // Brain fallback: direct read-only turn if the graph path fails. Loud,
      // so a broken brain never hides behind a working fallback.
      console.error("brain failed, falling back to direct turn:", err?.message ?? err);
      win?.webContents.send("session.stream", { delta: `[brain] ${String(err?.message ?? err).slice(0, 160)} — answering directly\n` });
      return promptJarvis(text, (d) => {
        win?.webContents.send("session.stream", { delta: d });
      }, files?.length ? { files } : {});
    });
    win?.webContents.send("session.done", { sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status });
    // The brain is read-only; if it says it can't run that instead of
    // delegating, give the request to a worker (which has the shell).
    if (r.status === "ok" && needsWorkerFallback(r.reply ?? r.text, r.dispatches)) {
      r.dispatches = [{ task: `The user asked: "${text}". Do this on the user's machine with your tools (you have shell access; risky commands will be put to the user for approval) and report the result in one or two sentences.` }];
      r.speak = "I'll have a worker check that on your machine.";
      win?.webContents.send("session.stream", { delta: "\n[act] no shell in the brain session — handing this to a worker\n" });
    }
    if (r.status === "ok") speak(win, r.speak ?? speechFor(r.reply ?? r.text ?? ""));
    else if (isVoiceMode(shellStore())) speak(win, "Sorry, that didn't work. The details are in the transcript.");
    const dispatched = [];
    for (const w of r.warnings ?? []) {
      win?.webContents.send("session.stream", { delta: `\n[act] ${w}\n` });
    }
    // The brain's reply already claimed it; a rejected action must be corrected out loud.
    if ((r.warnings ?? []).some((w) => w.startsWith("ignoring jarvis action"))) {
      speak(win, "Sorry, I couldn't apply that one. The details are in the transcript.");
    }
    for (const a of r.actions ?? []) await runJarvisAction(a, broadcast);
    for (const d of r.dispatches ?? []) {
      const dr = await dispatchTask(d.task, { agent: d.agent }, broadcast);
      if (dr.needBootstrap) {
        win?.webContents.send("session.stream", { delta: "\n[fleet] no agent yet — answer on the card\n" });
      } else if (!dr.ok) {
        win?.webContents.send("session.stream", { delta: `\n[fleet] dispatch refused: ${dr.reason}\n` });
      } else {
        win?.webContents.send("session.stream", { delta: `\n[fleet] ${dr.reason} → ${dr.agent} (${String(dr.sessionID).slice(0, 8)})${dr.branch ? ` on ${dr.branch}` : ""}\n` });
      }
      dispatched.push({ task: d.task, ...dr });
    }
    return { ok: true, sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status, files: files?.length ?? 0, dispatches: dispatched };
  };
  commitTextRef = commitText;
  ipcMain.handle("utterance.commit", async (_e, utterance, extra = {}) => {
    if (!utterance?.text || typeof utterance.text !== "string") {
      throw new Error("utterance.text required");
    }
    // Slash commands and skill mentions route to their endpoints, not the model.
    const cmd = parseSlash(utterance.text);
    if (cmd) {
      const { client } = await ensureClient();
      const sessionID = await ensureJarvisSession(projectDir());
      try {
        if (cmd.kind === "command") await client.session.command({ sessionID, name: cmd.name, text: cmd.rest });
        else await client.session.skill({ sessionID, id: cmd.name });
        return { ok: true, control: cmd.kind, name: cmd.name };
      } catch (err) {
        console.error(`slash ${cmd.kind} ${cmd.name} failed:`, err.message ?? err);
        throw err;
      }
    }
    try {
      return await commitText(utterance.text, extra.files);
    } catch (err) {
      console.error("utterance.commit failed:", err.message ?? err);
      throw err;
    }
  });
  ipcMain.handle("project.get", async () => projectInfo());
  ipcMain.handle("project.set", async (_e, { dir } = {}) => switchProject(dir, broadcast));
  ipcMain.handle("project.open", async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Open project folder" });
    if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true };
    return switchProject(r.filePaths[0], broadcast);
  });
  ipcMain.handle("chain.action", async (_e, { action, chainID } = {}) => chainAction(action, chainID, broadcast));
  ipcMain.handle("audio.start", async (_e, { simulate, engine } = {}) => {
    if (isListening()) return { ok: false, reason: "already-listening" };
    voiceSuspend = true;
    const partials = [];
    try {
      const fin = await listenOnce({
        simulate,
        engine,
        onPartial: (p) => {
          partials.push(p.text);
          win?.webContents.send("caption.partial", p);
        },
      });
      const utterance = toUtterance(fin);
      win?.webContents.send("caption.final", { id: utterance.id, text: utterance.text });
      // Same routed path as typed text. Spoken allow/deny/stop are controls.
      const r = await commitText(utterance.text);
      return { ok: true, utterance, ...r };
    } catch (err) {
      const reason = String(err.message ?? err);
      if (reason !== "listen stopped") win?.webContents.send("audio.error", { message: reason });
      return { ok: false, reason };
    } finally {
      voiceSuspend = false;
    }
  });
  ipcMain.handle("audio.stop", async () => {
    voiceSuspend = false;
    stopListening();
    return { ok: true };
  });
  ipcMain.handle("fleet.spawn", async (_e, { task, agent, directory } = {}) => {
    if (!task || typeof task !== "string") throw new Error("fleet.spawn: task required");
    return dispatchTask(task, { agent, directory }, broadcast);
  });
  ipcMain.handle("bootstrap.answer", async (_e, { id, text } = {}) => {
    if (!id || typeof text !== "string") throw new Error("bootstrap.answer: id + text required");
    const r = await answerBootstrapText(id, text, win, broadcast);
    return { ok: true, ...r };
  });
  ipcMain.handle("bootstrap.cancel", async (_e, { id } = {}) => {
    if (!id) throw new Error("bootstrap.cancel: id required");
    bootStash.delete(id);
    broadcast({ kind: "bootstrap.cancelled", id });
    return { ok: true };
  });
  ipcMain.handle("fleet.list", async () => ({ ok: true, workers: snapshot() }));
  ipcMain.handle("fleet.stop", async (_e, { sessionID } = {}) => {
    const id = sessionID ?? latestActiveWorker()?.sessionID;
    if (!id) return { ok: false, reason: "no active worker" };
    await stopWorker(id);
    broadcast({ kind: "fleet.state", snapshot: snapshot() });
    return { ok: true, sessionID: id };
  });
  ipcMain.handle("fleet.delete", async (_e, { sessionID } = {}) => {
    if (!sessionID) throw new Error("fleet.delete: sessionID required");
    await deleteWorker(sessionID);
    broadcast({ kind: "fleet.state", snapshot: snapshot() });
    return { ok: true };
  });
  ipcMain.handle("session.rename", async (_e, { sessionID, title } = {}) => {
    const r = await renameSession(sessionID, title);
    broadcast({ kind: "fleet.state", snapshot: snapshot() });
    return r;
  });
  ipcMain.handle("session.fork", async (_e, { sessionID, before } = {}) => forkSession(sessionID, before));
  ipcMain.handle("session.list", async () => ({ ok: true, sessions: await listSessions() }));
  ipcMain.handle("session.switchAgent", async (_e, { sessionID, agent } = {}) => switchSessionAgent(sessionID, agent));
  ipcMain.handle("session.switchModel", async (_e, { sessionID, providerID, id } = {}) => switchSessionModel(sessionID, providerID, id));
  ipcMain.handle("agent.list", async () => ({ ok: true, agents: await listAgents(projectDir()) }));
  ipcMain.handle("model.list", async () => ({ ok: true, models: await listModels() }));
  ipcMain.handle("command.list", async () => ({ ok: true, commands: await listCommands() }));
  ipcMain.handle("skill.list", async () => ({ ok: true, skills: await listSkills() }));
  ipcMain.handle("session.command", async (_e, { sessionID, name, text, files } = {}) => {
    const { client } = await ensureClient();
    return { ok: true, sent: await client.session.command({ sessionID, name, text: text ?? "", files }) };
  });
  ipcMain.handle("session.skill", async (_e, { sessionID, id } = {}) => {
    const { client } = await ensureClient();
    await client.session.skill({ sessionID, id });
    return { ok: true };
  });
  ipcMain.handle("session.diff", async (_e, { sessionID } = {}) => ({ ok: true, diff: await getDiff(sessionID) }));
  ipcMain.handle("message.list", async (_e, { sessionID, limit } = {}) => ({ ok: true, messages: await listMessages(sessionID, limit) }));
  ipcMain.handle("session.undo", async (_e, { sessionID, messageID } = {}) => {
    const r = await undoMessage(sessionID, messageID);
    broadcast({ kind: "fleet.state", snapshot: snapshot() });
    return r;
  });
  ipcMain.handle("term.start", async (_e, { command, timeout } = {}) => termStart(command, projectDir(), timeout));
  ipcMain.handle("term.output", async (_e, { id, cursor } = {}) => termOutput(id, projectDir(), cursor));
  ipcMain.handle("term.kill", async (_e, { id } = {}) => termKill(id, projectDir()));
  ipcMain.handle("pty.open", async () => ptyOpen(projectDir()));
  ipcMain.handle("pty.attach", async (_e, { ptyID, cursor } = {}) => {
    const push = (kind) => (payload) => win?.webContents.send(kind, payload);
    return ptyAttach(ptyID, projectDir(), {
      cursor,
      onChunk: push("pty.data"),
      onMeta: push("pty.meta"),
      onClose: push("pty.exit"),
    });
  });
  ipcMain.handle("pty.write", async (_e, { ptyID, data } = {}) => ptyWrite(ptyID, data));
  ipcMain.handle("pty.detach", async (_e, { ptyID } = {}) => ptyDetach(ptyID));
  ipcMain.handle("pty.resize", async (_e, { ptyID, rows, cols } = {}) => ptyResize(ptyID, projectDir(), rows, cols));
  ipcMain.handle("pty.close", async (_e, { ptyID } = {}) => ptyClose(ptyID, projectDir()));
  ipcMain.handle("mcp.list", async () => {
    const { client } = await ensureClient();
    return { ok: true, servers: (await client.mcp.list()).data ?? [] };
  });
  ipcMain.handle("integration.list", async () => {
    const { client } = await ensureClient();
    return { ok: true, providers: (await client.integration.list()).data ?? [] };
  });
  ipcMain.handle("oauth.connect", async (_e, { integrationID, methodID } = {}) => {
    const { client } = await ensureClient();
    return { ok: true, attempt: await client.integration.oauth.connect({ integrationID, methodID }) };
  });
  ipcMain.handle("oauth.cancel", async (_e, { integrationID, attemptID } = {}) => {
    const { client } = await ensureClient();
    await client.integration.oauth.cancel({ integrationID, attemptID });
    return { ok: true };
  });
  ipcMain.handle("project.list", async () => ({ ok: true, projects: await listProjects() }));
  ipcMain.handle("worktree.here", async () => ({ ok: true, worktrees: await listWorktrees(await projectIDFor(projectDir())) }));
  ipcMain.handle("worktree.list", async (_e, { projectID } = {}) => ({ ok: true, worktrees: await listWorktrees(projectID) }));
  ipcMain.handle("worktree.create", async (_e, args = {}) => ({ ok: true, worktree: await createWorktree(args.projectID, args) }));
  ipcMain.handle("worktree.remove", async (_e, { projectID, directory } = {}) => removeWorktree(projectID, directory));
  ipcMain.handle("session.compact", async (_e, { sessionID } = {}) => ({ ok: true, compaction: await compactSession(sessionID) }));
  ipcMain.handle("permission.respond", async (_e, { requestID, decision } = {}) => {
    if (!requestID || (decision !== "allow" && decision !== "deny")) {
      throw new Error("permission.respond: requestID + allow|deny required");
    }
    await replyPermission(requestID, decision);
    return { ok: true, requestID, decision };
  });
  ipcMain.handle("app.command", async (_e, { name, args } = {}) => {
    if (name === "set.jarvisModel") {
      // Validate against the server list BEFORE saving: a bad model must never persist.
      const m = String(args?.value ?? "");
      const slash = m.indexOf("/");
      if (slash < 0) throw new Error("set.jarvisModel: want provider/id");
      await setBrainModel(m.slice(0, slash), m.slice(slash + 1));
    }
    const entry = applyAppCommand(shellStore(), name, args);
    broadcast({ kind: "settings.applied", entry, settings: shellStore().settings });
    onVoiceSettings(name, args?.value);
    // The deck's voice button goes through here: it must start/stop the loop
    // exactly like the spoken "voice mode on/off" does.
    if (name === "set.voiceMode") {
      if (args?.value === "on") voiceLoop(commitText, win);
      else { stopListening(); hush(win); convo.close(); paintConversation(win); }
    }
    return { ok: true, entry };
  });
  ipcMain.handle("tts.state", async (_e, { speaking } = {}) => {
    setSpeaking(speaking);
    return { ok: true };
  });
  ipcMain.handle("settings.get", async () => ({
    ok: true,
    settings: shellStore().settings,
    audit: shellStore().audit,
    accents: ACCENTS,
    voices: VOICES.map((id) => ({ id, label: VOICE_LABELS[id] ?? id })),
    followUps: FOLLOW_UPS,
    neuralVoice: hasNeuralVoice(),
    conversation: convo.isOpen(),
  }));
  // First-run setup: the deck's wizard collects name, brain model, worker model
  // and voice, then saves them here in one go. Everything is validated first
  // (the brain model against the live server) so a bad answer saves nothing.
  ipcMain.handle("onboarding.complete", async (_e, answers = {}) => {
    const plan = [
      ["set.userName", "name", String(answers.name ?? "").trim()],
      ["set.jarvisModel", "jarvisModel", String(answers.jarvisModel ?? "")],
      ["set.workerModel", "workerModel", String(answers.workerModel ?? "")],
      ["set.voice", "voice", String(answers.voice ?? "")],
    ];
    const errors = {};
    for (const [name, field, value] of plan) {
      try { validateAppCommand(name, { value }); } catch (err) { errors[field] = String(err.message ?? err); }
    }
    if (!errors.jarvisModel) {
      const m = plan[1][2];
      const slash = m.indexOf("/");
      try { await setBrainModel(m.slice(0, slash), m.slice(slash + 1)); }
      catch (err) { errors.jarvisModel = String(err.message ?? err); }
    }
    if (Object.keys(errors).length) return { ok: false, errors };
    for (const [name, , value] of [...plan, ["set.onboarded", "", "on"]]) {
      const entry = applyAppCommand(shellStore(), name, { value });
      broadcast({ kind: "settings.applied", entry, settings: shellStore().settings });
      onVoiceSettings(name, value);
    }
    return { ok: true, settings: shellStore().settings };
  });
  // Jarvis speaking outside voice mode (setup wizard): one line, in a given
  // voice (default: the configured one). Returns WAV bytes for the deck to play.
  ipcMain.handle("voice.say", async (_e, { text, voice } = {}) => {
    const t = String(text ?? "").trim().slice(0, 400);
    const v = VOICES.includes(voice) ? voice : shellStore().settings.voice;
    if (!t) return { ok: false, reason: "empty" };
    try {
      const r = await synthesize(t, v);
      return r ? { ok: true, text: t, audio: r.audio, ms: r.ms } : { ok: false, text: t, reason: "no neural voice on this Mac" };
    } catch (err) {
      return { ok: false, text: t, reason: String(err.message ?? err) };
    }
  });
  // Settings → Voice: hear a voice before (or after) choosing it. Works with
  // voice mode off; renders through the same helper Jarvis speaks with.
  ipcMain.handle("voice.preview", async (_e, { voice } = {}) => {
    const v = VOICES.includes(voice) ? voice : shellStore().settings.voice;
    const line = `Hello, I'm Jarvis. ${VOICE_LABELS[v]?.split(" — ")[0] ?? "This"} is how I sound. What shall we build today?`;
    try {
      const r = await synthesize(line, v);
      return r ? { ok: true, text: line, audio: r.audio, ms: r.ms } : { ok: false, text: line, reason: "no neural voice on this Mac" };
    } catch (err) {
      return { ok: false, text: line, reason: String(err.message ?? err) };
    }
  });
  ipcMain.handle("dialog.attach", async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openFile"], title: "Attach file to next message" });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    const p = r.filePaths[0];
    return { ok: true, uri: "file://" + p, name: p.split("/").pop() };
  });
  ipcMain.handle("config.confirm", async (_e, { pendingID, confirmed } = {}) => {
    if (!pendingID || typeof confirmed !== "boolean") throw new Error("config.confirm: pendingID + confirmed required");
    const r = await confirmWidening((await ensureClient()).client, projectDir(), pendingID, confirmed, widenHooks());
    broadcastConfig(r);
    return { ok: true, ...r };
  });
  ipcMain.handle("config.pending", async () => ({
    ok: true,
    pending: [...pendingConfigs.values()].map(publicPending),
  }));
  ipcMain.handle("form.reply", async (_e, { sessionID, formID, answer } = {}) => {
    if (!sessionID || !formID || !answer) throw new Error("form.reply: sessionID + formID + answer required");
    await replyForm(sessionID, formID, answer);
    broadcast({ kind: "form.resolved", sessionID });
    return { ok: true };
  });
  ipcMain.handle("form.list", async (_e, { sessionID } = {}) => {
    if (!sessionID) throw new Error("form.list: sessionID required");
    return { ok: true, forms: await refreshForms(sessionID) };
  });
  await createWindow();
  if (isVoiceMode(shellStore())) voiceLoop(commitText, win);
  import("./brain/memory.js").then((m) => m.warmEmbeddings()).catch(() => {});
});

app.on("window-all-closed", () => {
  ptyDetachAll();
  if (process.platform !== "darwin") app.quit();
});
