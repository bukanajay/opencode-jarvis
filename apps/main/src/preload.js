import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvis", {
  commitUtterance: (utterance) => ipcRenderer.invoke("utterance.commit", utterance),
  audioStart: (opts) => ipcRenderer.invoke("audio.start", opts ?? {}),
  audioStop: () => ipcRenderer.invoke("audio.stop"),
  onStream: (fn) => ipcRenderer.on("session.stream", (_e, payload) => fn(payload)),
  onDone: (fn) => ipcRenderer.on("session.done", (_e, payload) => fn(payload)),
  onCaption: (fn) => ipcRenderer.on("caption.partial", (_e, payload) => fn(payload)),
  onCaptionFinal: (fn) => ipcRenderer.on("caption.final", (_e, payload) => fn(payload)),
  onAudioError: (fn) => ipcRenderer.on("audio.error", (_e, payload) => fn(payload)),
});
