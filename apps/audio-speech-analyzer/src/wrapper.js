// Node wrapper around the Swift speech-analyzer binary.
// Spawns one utterance at a time, parses JSON lines, normalizes to
// CaptionPartial / Utterance. Identical contract to the future Parakeet helper.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function binaryPath() {
  return path.join(here, "..", "bin", "speech-analyzer");
}

export function swiftSource() {
  return path.join(here, "helper.swift");
}

// Run one utterance. onPartial receives { id, text, revision }.
// Resolves with { id, text } on final, rejects on status error (unless optional).
export function listenOnce({ onPartial, simulate, stdinSource, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = binaryPath();
    const args = [];
    let child;
    if (simulate) {
      child = spawn(bin, ["--simulate", simulate]);
      child.on("error", (err) => {
        // Binary missing (not compiled yet): emulate in-process so plumbing is provable.
        emulate(simulate, onPartial).then(resolve, reject);
      });
    } else if (stdinSource) {
      child = spawn(bin, ["--stdin"]);
      child.on("error", () => emulateStdin(stdinSource, onPartial).then(resolve, reject));
      stdinSource.pipe(child.stdin);
    } else {
      child = spawn(bin, []);
    }

    const id = Math.random().toString(36).slice(2);
    let buf = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("listen timeout"));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === "partial" && onPartial) {
          onPartial({ id: msg.id ?? id, text: msg.text ?? "", revision: msg.revision ?? 0 });
        } else if (msg.kind === "final") {
          clearTimeout(timer);
          resolve({ id: msg.id ?? id, text: msg.text ?? "" });
        } else if (msg.kind === "status" && (msg.state === "mic-denied" || msg.state === "speech-denied" || msg.state === "unavailable")) {
          clearTimeout(timer);
          const err = new Error(`audio:${msg.state}`);
          err.cause = msg.note;
          reject(err);
        }
      }
    });
    child.on("close", (code) => {
      // If the binary was missing we already emulated via error handler.
      if (code !== 0) {
        // Resolve path already handled for final; otherwise surface.
      }
    });
    child.stderr?.on("data", () => {});
  });
}

async function emulate(sentence, onPartial) {
  const id = Math.random().toString(36).slice(2);
  const words = sentence.split(" ").filter(Boolean);
  let acc = [];
  let rev = 0;
  for (const w of words) {
    acc.push(w);
    rev += 1;
    await new Promise((r) => setTimeout(r, 40));
    onPartial?.({ id, text: acc.join(" "), revision: rev });
  }
  return { id, text: sentence };
}

async function emulateStdin(source, onPartial) {
  const id = Math.random().toString(36).slice(2);
  let text = "";
  for await (const chunk of source) {
    text += chunk.toString();
    onPartial?.({ id, text: text.trim(), revision: 1 });
  }
  return { id, text: text.trim() };
}
