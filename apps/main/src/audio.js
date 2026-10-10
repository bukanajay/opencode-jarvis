// Main-side audio ownership. Spawns one utterance at a time from whichever
// helper JARVIS_AUDIO_ENGINE selects (default: parakeet on Apple Silicon once
// its live binary is built, else speech-analyzer). Both helpers speak
// protocol.md, so the deck cannot tell engines apart. Final -> Utterance with
// source:"speech".
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PARAKEET_LIVE = path.join(here, "../../audio-parakeet/bin/parakeet");
const PARAKEET_SIM = path.join(here, "../../audio-parakeet/bin/parakeet-sim");

export const ENGINES = {
  "speech-analyzer": { bin: path.join(here, "../../audio-speech-analyzer/bin/speech-analyzer"), label: "speech-analyzer" },
  // The live binary (npm run build:parakeet) wins; the sim covers Intel and CI.
  parakeet: { bin: existsSync(PARAKEET_LIVE) ? PARAKEET_LIVE : PARAKEET_SIM, label: "parakeet-v3" },
};

export function defaultEngine({ platform = process.platform, arch = process.arch, hasParakeet = existsSync(PARAKEET_LIVE) } = {}) {
  return platform === "darwin" && arch === "arm64" && hasParakeet ? "parakeet" : "speech-analyzer";
}

export function resolveEngine(name) {
  const key = name ?? process.env.JARVIS_AUDIO_ENGINE ?? defaultEngine();
  const eng = ENGINES[key];
  if (!eng) throw new Error(`unknown audio engine: ${key} (known: ${Object.keys(ENGINES).join(", ")})`);
  return { key, ...eng };
}

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
export function listenOnce({ onPartial, simulate, replay, timeoutMs = 90000, engine } = {}) {
  stopListening();
  const eng = resolveEngine(engine);
  return new Promise((resolve, reject) => {
    // replay: parakeet streams an audio file through its live VAD path (proofs).
    const args = simulate ? ["--simulate", simulate] : replay ? ["--replay", replay] : [];
    const child = spawn(eng.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
          done(resolve, { id: msg.id, text: msg.text ?? "", engine: eng.label });
        } else if (msg.kind === "status" && msg.state !== "listening") {
          if (msg.state === "mic-denied" || msg.state === "speech-denied" || msg.state === "unavailable" || msg.state === "mic-error") {
            clearTimeout(timer);
            done(reject, new Error(`audio:${msg.state}${msg.note ? ` — ${msg.note}` : ""}`));
          }
        }
      }
    });
    // Killed (stopListening) or exited without a final: settle instead of hanging until the timeout.
    child.on("close", () => { clearTimeout(timer); done(reject, new Error("listen stopped")); });
  });
}

export function toUtterance({ id, text, engine }, fallback = "speech-analyzer") {
  return { id: id ?? Math.random().toString(36).slice(2), text, source: "speech", engine: engine ?? fallback, committedAt: Date.now() };
}
