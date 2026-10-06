import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvis", {
  commitUtterance: (utterance) => ipcRenderer.invoke("utterance.commit", utterance),
  onStream: (fn) => ipcRenderer.on("session.stream", (_e, payload) => fn(payload)),
});
