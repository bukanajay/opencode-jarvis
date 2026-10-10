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
// inConversation: a "hey jarvis" opened a conversation window that is still
// open, so plain speech is addressed to Jarvis without the wake word.
// Actions: wake-task {text} (opens/extends the window), wake-empty (opens it),
// follow-up {text} (inside the window, no wake), ack (polite filler inside the
// window, nothing to do), dismiss (closes it), ignored.
// answering: Jarvis asked a question (e.g. a permission) and is waiting, so
// short replies like "okay" / "yes" are answers, never filler.
export function nextVoiceAction(transcript, { voiceMode, wakeWord, inConversation = false, answering = false } = {}) {
  if (voiceMode !== "on") return { action: "ignored" };
  const wake = String(wakeWord ?? "jarvis").trim() || "jarvis";
  const woke = hasWake(transcript, wake);
  if (!woke && !inConversation) return { action: "ignored" };
  const rest = woke ? stripWake(transcript, wake) : String(transcript ?? "").trim();
  if (isDismissal(rest)) return { action: "dismiss" };
  if (!rest) return woke ? { action: "wake-empty" } : { action: "ignored" };
  if (!woke && !answering && isAck(rest)) return { action: "ack" };
  return { action: woke ? "wake-task" : "follow-up", text: rest };
}

const bare = (t) => String(t ?? "").toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();

// Ends the conversation: back to needing "hey jarvis".
export function isDismissal(text) {
  return /^(?:(?:ok(?:ay)?|thanks|thank you|cool|great)(?:\s+jarvis)?\s+)?(?:that's all|that is all|that'll be all|that will be all|we're done|we are done|i'm done|goodbye|good bye|bye|go to sleep|stop listening|that's it for now|that's it)(?:\s+(?:for now|thanks|thank you|jarvis))*$/.test(bare(text));
}

// Filler that should neither start a model turn nor end the conversation.
export function isAck(text) {
  return /^(?:ok(?:ay)?|thanks|thank you|cool|great|nice|got it|alright|all right|perfect|awesome|sounds good|mm+|hmm+|uh+|um+|yeah|yep|right)(?:\s+(?:thanks|thank you|jarvis))?$/.test(bare(text));
}

// Conversation window: opened by the wake word, kept open while Jarvis thinks
// or talks, and for `followUpMs` after the last exchange. followUpMs 0 = off
// (every utterance needs the wake word). Pure; the clock is injected.
export function createConversation({ now = () => Date.now() } = {}) {
  let active = false;
  let until = 0;
  const holds = new Set(); // "turn" (Jarvis thinking), "speaking": cannot expire meanwhile
  return {
    open(followUpMs) {
      if (!(followUpMs > 0)) return false;
      active = true;
      until = Math.max(until, now() + followUpMs);
      return true;
    },
    // Restart the countdown after an exchange (only if a window is open).
    touch(followUpMs) {
      if (active && followUpMs > 0) until = Math.max(until, now() + followUpMs);
    },
    hold(key) { holds.add(key); },
    release(key, followUpMs) { if (holds.delete(key) && holds.size === 0) this.touch(followUpMs); },
    close() { active = false; until = 0; },
    isOpen() {
      if (!active) return false;
      if (holds.size > 0 || now() < until) return true;
      active = false;
      return false;
    },
    remainingMs() { return this.isOpen() ? (holds.size > 0 ? Infinity : until - now()) : 0; },
  };
}

export function followUpMs(setting) {
  const n = Number(String(setting ?? "").replace(/s$/, ""));
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
}
