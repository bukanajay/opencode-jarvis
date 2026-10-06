// Main-side audio ownership. Spawns the Swift speech-analyzer helper,
// one utterance at a time. Partials -> renderer caption. Final -> Utterance
// with source:"speech", routed through the SAME promptJarvis path as typed.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "../../audio-speech-analyzer/bin/speech-analyzer");

let active = null;

export function isListening() {
  return active !== null;
}

export function stopListening() {
  if (active) {
    try { active.kill("SIGKILL"); } catch {}
    active = null;
  }
}

// onPartial({ id, text, revision }) — renderer replaces caption, never appends.
// Resolves { id, text } on final. Rejects on mic/speech denial or timeout.
export function listenOnce({ onPartial, simulate, timeoutMs = 90000 } = {}) {
  stopListening();
  return new Promise((resolve, reject) => {
    const args = simulate ? ["--simulate", simulate] : [];
    const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    active = child;
    const done = (fn, val) => {
      if (active === child) active = null;
      fn(val);
    };
    child.on("error", (err) => done(reject, new Error(`audio spawn failed: ${err.message}`)));
    let buf = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      done(reject, new Error("listen timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === "partial" && onPartial) {
          onPartial({ id: msg.id, text: msg.text ?? "", revision: msg.revision ?? 0 });
        } else if (msg.kind === "final") {
          clearTimeout(timer);
          try { child.kill("SIGKILL"); } catch {}
          done(resolve, { id: msg.id, text: msg.text ?? "" });
        } else if (msg.kind === "status" && msg.state !== "listening") {
          if (msg.state === "mic-denied" || msg.state === "speech-denied" || msg.state === "unavailable" || msg.state === "mic-error") {
            clearTimeout(timer);
            done(reject, new Error(`audio:${msg.state}${msg.note ? ` — ${msg.note}` : ""}`));
          }
        }
      }
    });
    child.on("close", () => {});
  });
}

export function toUtterance({ id, text }, engine = "speech-analyzer") {
  return { id: id ?? Math.random().toString(36).slice(2), text, source: "speech", engine, committedAt: Date.now() };
}
