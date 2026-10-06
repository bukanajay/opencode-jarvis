import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClient } from "./service.js";
import { promptJarvis, ensureJarvisSession } from "./sessions.js";
import { listenOnce, toUtterance, isListening, stopListening } from "./audio.js";
import { ensureFleetPump, spawnWorker, stopWorker, deleteWorker, replyPermission, latestActiveWorker, snapshot, pendingPermissions, routeUtterance, listSessions, renameSession, forkSession } from "./fleet.js";
import { loadStore, applyAppCommand, ACCENTS } from "./shell.js";
import { applyAgentFile, stageWidening, confirmWidening, pendingConfigs } from "./config.js";
import { pendingForms, refreshForms, replyForm, matchFormAnswer, formsFor } from "./forms.js";

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

function matchPendingForm(text) {
  for (const p of [...pendingForms.values()].reverse()) {
    const answer = matchFormAnswer(p.form, text);
    if (answer) return { formID: p.formID, sessionID: p.sessionID, answer };
  }
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
      preload: path.join(here, "preload.js"),
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
  const commitText = async (text) => {
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
      return { ok: true, control: "app.command", entry };
    }
    const r = await promptJarvis(text, (d) => {
      win?.webContents.send("session.stream", { delta: d });
    });
    win?.webContents.send("session.done", { sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status });
    return { ok: true, sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status };
  };
  ipcMain.handle("utterance.commit", async (_e, utterance) => {
    if (!utterance?.text || typeof utterance.text !== "string") {
      throw new Error("utterance.text required");
    }
    return commitText(utterance.text);
  });
  ipcMain.handle("audio.start", async (_e, { simulate } = {}) => {
    if (isListening()) return { ok: false, reason: "already-listening" };
    const partials = [];
    try {
      const fin = await listenOnce({
        simulate,
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
    }
  });
  ipcMain.handle("audio.stop", async () => {
    stopListening();
    return { ok: true };
  });
  ipcMain.handle("fleet.spawn", async (_e, { task, agent } = {}) => {
    if (!task || typeof task !== "string") throw new Error("fleet.spawn: task required");
    const r = await spawnWorker(task, { agent });
    broadcast({ kind: "fleet.state", snapshot: snapshot() });
    return { ok: true, ...r };
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
