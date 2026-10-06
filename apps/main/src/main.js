import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClient } from "./service.js";
import { promptJarvis, ensureJarvisSession } from "./sessions.js";
import { listenOnce, toUtterance, isListening, stopListening } from "./audio.js";
import { ensureFleetPump, spawnWorker, stopWorker, deleteWorker, replyPermission, latestActiveWorker, snapshot, pendingPermissions, routeUtterance } from "./fleet.js";
import { loadStore, applyAppCommand, ACCENTS } from "./shell.js";

let shell = null;
const shellStore = () => (shell ??= loadStore());


async function answerPending(decision) {
  const [requestID] = [...pendingPermissions.keys()];
  const r = await replyPermission(requestID, decision);
  return { requestID, decision, r };
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
    else broadcast({ kind: "fleet.state", snapshot: ev.snapshot });
  });
  const commitText = async (text) => {
    const routed = routeUtterance(text);
    if (routed.route === "permission") {
      const r = await answerPending(routed.decision);
      return { ok: true, control: "permission", ...r };
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
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
