import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClient } from "./service.js";
import { promptJarvis, ensureJarvisSession } from "./sessions.js";

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
    let full = "";
    await promptJarvis(utterance.text, (d) => {
      full += d;
      win?.webContents.send("session.stream", { delta: d });
    });
    return { ok: true };
  });
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
