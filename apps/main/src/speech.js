// Spoken replies: what Jarvis says out loud in voice mode, and when the mic
// may interrupt it. All pure; the deck owns the actual text-to-speech.
import { hasWake, stripWake } from "./voice.js";

const SPEAK_RE = /^\s*```speak\s+(\{.*\})\s*```\s*$/m;
const MAX_SPOKEN = 260;

// The model's own spoken line: ```speak {"text": "..."}``` on a line of its own.
export function parseSpeak(reply) {
  const m = String(reply ?? "").match(SPEAK_RE);
  if (!m) return null;
  try {
    const spec = JSON.parse(m[1]);
    const text = String(spec?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text || Object.keys(spec).some((k) => k !== "text")) return null;
    return clipWords(text, MAX_SPOKEN * 2);
  } catch {
    return null;
  }
}

function clipWords(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const at = cut.lastIndexOf(" ");
  return `${(at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, "")}…`;
}

// Fallback when the model gave no speak fence: the first sentence or two of
// the visible reply, with everything that reads badly aloud removed (fences,
// code, paths, URLs, markdown, [fleet]-style system lines).
export function spokenSummary(reply, max = MAX_SPOKEN) {
  let t = String(reply ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((ln) => !/^\s*\[[a-z]+\]/i.test(ln))
    .join(" ");
  t = t
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/(?:^|\s)(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]*\w/g, " a file")
    .replace(/[*_#>|~]+/g, " ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const sentences = t.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [t];
  let out = sentences[0].trim();
  if (sentences[1] && out.length + sentences[1].length < max) out = `${out} ${sentences[1].trim()}`;
  return clipWords(out, max);
}

// What to say for a finished brain reply: the model's speak line, else the
// local summary.
export function speechFor(reply) {
  return parseSpeak(reply) ?? spokenSummary(stripSpeak(reply));
}

export function stripSpeak(reply) {
  return String(reply ?? "").split("\n").filter((ln) => !/^\s*```speak\s+\{.*\}\s*```\s*$/.test(ln)).join("\n");
}

// While Jarvis is speaking (plus a short tail for room echo) the mic hears
// Jarvis itself, so a bare "jarvis" in its own voice must not trigger. Only an
// explicit "hey/ok <wake> ..." gets through, and it interrupts the speech.
// Returns: "pass" (normal handling), "drop", or "barge" (stop speech, then
// handle as a wake task).
export function voiceGate(transcript, { speaking, wakeWord = "jarvis" } = {}) {
  if (!speaking) return "pass";
  const t = String(transcript ?? "").trim();
  const wake = String(wakeWord || "jarvis").trim();
  if (!hasWake(t, wake)) return "drop";
  const explicit = new RegExp(`^\\s*(?:hey|ok|okay)\\s+${wake.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
  return explicit && stripWake(t, wake) !== t.trim() ? "barge" : "drop";
}

// What Jarvis says when a worker needs approval: who, what, and the question.
export function permissionLine(request, agent = "") {
  const action = String(request?.action ?? "something").toLowerCase();
  const what = (request?.resources ?? []).map(String).filter(Boolean).join(", ").replace(/\s+/g, " ").trim();
  const short = what.length > 90 ? `${what.slice(0, 87)}…` : what;
  const who = agent ? `The ${agent} worker` : "A worker";
  const verb = /bash|shell|command|exec/.test(action) ? "run" : /edit|write|patch/.test(action) ? "edit" : /web|fetch/.test(action) ? "fetch" : `use ${action} on`;
  return short ? `${who} wants to ${verb} ${short}. Allow it?` : `${who} needs ${action} permission. Allow it?`;
}

// "hey jarvis stop" / "quiet" / "shut up" while speaking: stop, nothing else.
export function isHush(text) {
  return /^(stop|quiet|silence|shut up|be quiet|enough|cancel|never ?mind)[.!]?$/i.test(String(text ?? "").trim());
}
