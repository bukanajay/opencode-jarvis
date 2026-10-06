import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClient } from "./service.js";
import { promptJarvis, ensureJarvisSession } from "./sessions.js";
import { listenOnce, toUtterance, isListening, stopListening } from "./audio.js";

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
  ipcMain.handle("utterance.commit", async (_e, utterance) => {
    if (!utterance?.text || typeof utterance.text !== "string") {
      throw new Error("utterance.text required");
    }
    // Typed and speech utterances converge here. No separate model path.
    const r = await promptJarvis(utterance.text, (d) => {
      win?.webContents.send("session.stream", { delta: d });
    });
    win?.webContents.send("session.done", { sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status });
    return { ok: true, sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status };
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
      // Same prompt path as text. Commit on end of utterance.
      const r = await promptJarvis(utterance.text, (d) => {
        win?.webContents.send("session.stream", { delta: d });
      });
      win?.webContents.send("session.done", { sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status });
      return { ok: true, utterance, sessionID: r.sessionID, modelUsed: r.modelUsed, status: r.status };
    } catch (err) {
      win?.webContents.send("audio.error", { message: String(err.message ?? err) });
      return { ok: false, reason: String(err.message ?? err) };
    }
  });
  ipcMain.handle("audio.stop", async () => {
    stopListening();
    return { ok: true };
  });
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
