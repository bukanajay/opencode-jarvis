import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClient } from "./service.js";
import { promptJarvis, ensureJarvisSession } from "./sessions.js";
import { listenOnce, toUtterance, isListening, stopListening } from "./audio.js";
import { ensureFleetPump, spawnWorker, stopWorker, deleteWorker, replyPermission, latestActiveWorker, snapshot, pendingPermissions, routeUtterance, listSessions, renameSession, forkSession, switchSessionAgent, switchSessionModel, listAgents, listModels, listCommands, listSkills, getDiff, listMessages, undoMessage, listProjects, projectIDFor, listWorktrees, createWorktree, removeWorktree, compactSession } from "./fleet.js";
import { loadStore, applyAppCommand, ACCENTS } from "./shell.js";
import { brainRespond } from "./brain/brain.js";
import { applyAgentFile, stageWidening, confirmWidening, pendingConfigs } from "./config.js";
import { termStart, termOutput, termKill, ptyOpen, ptyResize, ptyClose, ptyAttach, ptyWrite, ptyDetach, ptyDetachAll } from "./terminal.js";
import { pendingForms, refreshForms, replyForm, matchFormAnswer, formsFor } from "./forms.js";
import { isVoiceMode, nextVoiceAction } from "./voice.js";
import { ensureFleetOrAsk, startCreate, answerCreate, pendingBootstraps } from "./bootstrap.js";
import { parseExplicitAgent, resolveAgent, getFleetRegistry } from "./autoroute.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bootStash = new Map(); // bootID -> { task, directory, gate, conv?, ctx? }
const latestBootstrap = () => [...bootStash.keys()].pop() ?? null;

let shell = null;
const shellStore = () => (shell ??= loadStore());

const latestConfigPending = () => [...pendingConfigs.keys()].pop() ?? null;
const publicPending = (s) => ({ pendingID: s.pendingID, kind: s.kind, summary: s.summary, rule: { action: s.action, resources: s.resources, effect: s.effect } });
const withDeleteTarget = (spec) => ({ ...spec, target: latestActiveWorker()?.sessionID ?? null });
const widenHooks = () => ({
  jarvisSessionID: async () => ensureJarvisSession(process.cwd()),
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
        fin = await listenOnce({ onPartial: (p) => win?.webContents.send("caption.partial", p) });
        failures = 0;
      } catch (err) {
        // Back off on repeated spawn failures (e.g. mic denied) instead of hot-looping.
        failures += 1;
        win?.webContents.send("audio.error", { message: String(err.message ?? err) });
        await sleep(Math.min(30000, 1500 * 2 ** Math.min(failures, 4)));
        continue;
      }
      const s = shellStore().settings;
      const next = nextVoiceAction(fin.text, { voiceMode: s.voiceMode, wakeWord: s.wake });
      if (next.action === "wake-task") {
        const utterance = toUtterance(fin);
        win?.webContents.send("caption.final", { id: utterance.id, text: utterance.text });
        try { await commitText(next.text); } catch (err) { console.error("voice commit failed:", err.message ?? err); }
      } else if (next.action === "wake-empty") {
        win?.webContents.send("caption.partial", { id: fin.id, text: `heard ${s.wake} — say a command`, revision: 0 });
      }
    }
  } finally {
    voiceRunning = false;
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

async function dispatchTask(task, { agent, directory } = {}, broadcast) {
  const dir = directory ?? process.cwd();
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
  const res = await spawnWorker(cleanTask, { agent: agent ?? r.agent, directory: dir });
  broadcast({ kind: "fleet.state", snapshot: snapshot() });
  return { ok: true, ...res, agent: agent ?? r.agent, reason: r.reason ?? `default->${agent ?? r.agent}` };
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

app.whenReady().then(async () => {
  await ensureClient();
  await ensureJarvisSession(process.cwd());
  const broadcast = (msg) => win?.webContents.send(msg.kind, msg);
  await ensureFleetPump((ev) => {
    if (ev.kind === "permission.waiting") broadcast({ kind: "permission.waiting", request: ev.request, snapshot: ev.snapshot });
    else if (ev.kind === "permission.resolved") broadcast({ kind: "permission.resolved", ...ev });
    else if (ev.kind === "worker.tool") broadcast({ kind: "session.tool", ...ev });
    else if (ev.kind === "worker.stream") broadcast({ kind: "worker.stream", ...ev });
    else if (ev.kind === "form.waiting") broadcast({ kind: "form.waiting", ...ev });
    else if (ev.kind === "form.resolved") broadcast({ kind: "form.resolved", ...ev });
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
        process.cwd(),
        latestConfigPending(),
        routed.confirmed,
        widenHooks(),
      );
      broadcastConfig(r);
      return { ok: true, control: "config.confirm", ...r };
    }
    if (routed.route === "config.apply") {
      const r = await applyAgentFile((await ensureClient()).client, process.cwd(), routed.spec);
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
      if (routed.name === "set.voiceMode") {
        if (routed.args?.value === "on") voiceLoop(commitText, win);
        else stopListening();
      }
      return { ok: true, control: "app.command", entry };
    }
    const r = await brainRespond(text, (d) => {
      win?.webContents.send("session.stream", { delta: d });
    }).catch(async () => promptJarvis(text, (d) => {
      // Brain fallback: direct session turn if the graph path fails.
      win?.webContents.send("session.stream", { delta: d });
    }, files?.length ? { files } : {}));
    win?.webContents.send("session.done", { sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status });
    const dispatched = [];
    for (const w of r.warnings ?? []) {
      win?.webContents.send("session.stream", { delta: `\n[act] ${w}\n` });
    }
    for (const d of r.dispatches ?? []) {
      const dr = await dispatchTask(d.task, { agent: d.agent }, broadcast);
      if (dr.needBootstrap) {
        win?.webContents.send("session.stream", { delta: "\n[fleet] no agent yet — answer on the card\n" });
      } else if (!dr.ok) {
        win?.webContents.send("session.stream", { delta: `\n[fleet] dispatch refused: ${dr.reason}\n` });
      } else {
        win?.webContents.send("session.stream", { delta: `\n[fleet] ${dr.reason} → ${dr.agent} (${String(dr.sessionID).slice(0, 8)})\n` });
      }
      dispatched.push({ task: d.task, ...dr });
    }
    return { ok: true, sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status, files: files?.length ?? 0, dispatches: dispatched };
  };
  ipcMain.handle("utterance.commit", async (_e, utterance, extra = {}) => {
    if (!utterance?.text || typeof utterance.text !== "string") {
      throw new Error("utterance.text required");
    }
    // Slash commands and skill mentions route to their endpoints, not the model.
    const cmd = parseSlash(utterance.text);
    if (cmd) {
      const { client } = await ensureClient();
      const sessionID = await ensureJarvisSession(process.cwd());
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
      win?.webContents.send("audio.error", { message: String(err.message ?? err) });
      return { ok: false, reason: String(err.message ?? err) };
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
  ipcMain.handle("agent.list", async () => ({ ok: true, agents: await listAgents(process.cwd()) }));
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
  ipcMain.handle("term.start", async (_e, { command, timeout } = {}) => termStart(command, process.cwd(), timeout));
  ipcMain.handle("term.output", async (_e, { id, cursor } = {}) => termOutput(id, process.cwd(), cursor));
  ipcMain.handle("term.kill", async (_e, { id } = {}) => termKill(id, process.cwd()));
  ipcMain.handle("pty.open", async () => ptyOpen(process.cwd()));
  ipcMain.handle("pty.attach", async (_e, { ptyID, cursor } = {}) => {
    const push = (kind) => (payload) => win?.webContents.send(kind, payload);
    return ptyAttach(ptyID, process.cwd(), {
      cursor,
      onChunk: push("pty.data"),
      onMeta: push("pty.meta"),
      onClose: push("pty.exit"),
    });
  });
  ipcMain.handle("pty.write", async (_e, { ptyID, data } = {}) => ptyWrite(ptyID, data));
  ipcMain.handle("pty.detach", async (_e, { ptyID } = {}) => ptyDetach(ptyID));
  ipcMain.handle("pty.resize", async (_e, { ptyID, rows, cols } = {}) => ptyResize(ptyID, process.cwd(), rows, cols));
  ipcMain.handle("pty.close", async (_e, { ptyID } = {}) => ptyClose(ptyID, process.cwd()));
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
  ipcMain.handle("worktree.here", async () => ({ ok: true, worktrees: await listWorktrees(await projectIDFor(process.cwd())) }));
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
    const entry = applyAppCommand(shellStore(), name, args);
    broadcast({ kind: "settings.applied", entry, settings: shellStore().settings });
    return { ok: true, entry };
  });
  ipcMain.handle("settings.get", async () => ({
    ok: true,
    settings: shellStore().settings,
    audit: shellStore().audit,
    accents: ACCENTS,
  }));
  ipcMain.handle("dialog.attach", async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openFile"], title: "Attach file to next message" });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    const p = r.filePaths[0];
    return { ok: true, uri: "file://" + p, name: p.split("/").pop() };
  });
  ipcMain.handle("config.confirm", async (_e, { pendingID, confirmed } = {}) => {
    if (!pendingID || typeof confirmed !== "boolean") throw new Error("config.confirm: pendingID + confirmed required");
    const r = await confirmWidening((await ensureClient()).client, process.cwd(), pendingID, confirmed, widenHooks());
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
