// Voice-mode gating: wake-word detect/strip + on/off gate. All pure, no I/O,
// no mic, no model. Main decides; these only classify transcripts.
const ATTN = "(?:hey|ok|okay)\\s+";

function escapeRegExp(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Case-insensitive; true if text contains the wake word as a word.
// Handles "hey jarvis", bare "jarvis", "ok jarvis".
export function hasWake(text, wakeWord) {
  const wake = String(wakeWord ?? "").trim();
  if (!wake) return false;
  return new RegExp(`\\b${escapeRegExp(wake)}\\b`, "i").test(String(text ?? ""));
}

// Remove ONE leading "hey <wake>" / "ok <wake>" / "<wake>" prefix plus one
// optional trailing comma/colon, then trim. Returns "" if nothing is left.
export function stripWake(text, wakeWord) {
  const wake = String(wakeWord ?? "").trim();
  if (!wake) return String(text ?? "").trim();
  const re = new RegExp(`^\\s*(?:${ATTN})?${escapeRegExp(wake)}\\b\\s*[:,]?\\s*`, "i");
  return String(text ?? "").replace(re, "").trim();
}

// Shell store shape: { settings: { voiceMode: "on"|"off", ... }, ... }.
export function isVoiceMode(shellStore) {
  return shellStore?.settings?.voiceMode === "on";
}

// Single decision point for the voice loop.
// voiceMode is the shell setting value ("on"|"off"); wakeWord defaults to "jarvis".
export function nextVoiceAction(transcript, { voiceMode, wakeWord } = {}) {
  if (voiceMode !== "on") return { action: "ignored" };
  const wake = String(wakeWord ?? "jarvis").trim() || "jarvis";
  if (!hasWake(transcript, wake)) return { action: "ignored" };
  const rest = stripWake(transcript, wake);
  if (!rest) return { action: "wake-empty" };
  return { action: "wake-task", text: rest };
}
