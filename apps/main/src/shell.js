// Shell settings: app-owned, next frame, no server involved.
// Allowlist enforced here. Widening rules live in Step 5, not here.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ALLOWLIST = ["set.accent", "set.density", "set.layout", "set.captionSize", "set.audioDevice", "set.wake", "set.voiceMode", "set.autoMode", "set.reviewMode", "set.isolation", "set.defaultAgent", "set.jarvisModel", "set.workerModel", "set.voice", "set.followUp", "set.userName", "set.onboarded"];

export const ACCENTS = {
  phosphor: "#c8f04a",
  amber: "#f5a623",
  ice: "#7dd3fc",
  ember: "#ff6b4a",
  dim: "#3a4543",
};
// Jarvis's speaking voice: Kokoro English voice ids (jarvis-voice helper).
// b = British, a = American; m = male, f = female.
export const VOICES = [
  "bm_george", "bm_fable", "bm_lewis", "bm_daniel",
  "am_michael", "am_onyx", "am_fenrir", "am_puck", "am_adam", "am_echo", "am_eric", "am_liam",
  "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
  "af_heart", "af_bella", "af_nicole", "af_sarah", "af_nova", "af_sky",
];
export const VOICE_LABELS = {
  bm_george: "George — British, male", bm_fable: "Fable — British, male", bm_lewis: "Lewis — British, male", bm_daniel: "Daniel — British, male",
  am_michael: "Michael — American, male", am_onyx: "Onyx — American, male", am_fenrir: "Fenrir — American, male", am_puck: "Puck — American, male",
  am_adam: "Adam — American, male", am_echo: "Echo — American, male", am_eric: "Eric — American, male", am_liam: "Liam — American, male",
  bf_emma: "Emma — British, female", bf_isabella: "Isabella — British, female", bf_alice: "Alice — British, female", bf_lily: "Lily — British, female",
  af_heart: "Heart — American, female", af_bella: "Bella — American, female", af_nicole: "Nicole — American, female",
  af_sarah: "Sarah — American, female", af_nova: "Nova — American, female", af_sky: "Sky — American, female",
};
// Conversation follow-up window after "hey jarvis", in seconds; off = always need the wake word.
export const FOLLOW_UPS = ["off", "15", "30", "60", "120"];
export const DENSITIES = ["comfortable", "compact"];
export const LAYOUTS = ["deck", "wide"];
export const CAPTION_SIZES = ["small", "medium", "large"];

export const DEFAULTS = {
  accent: "phosphor",
  density: "comfortable",
  layout: "deck",
  captionSize: "medium",
  audioDevice: "default",
  wake: "jarvis",
  voiceMode: "off",
  autoMode: "off",
  reviewMode: "on",
  isolation: "worktree",
  defaultAgent: "build",
  jarvisModel: "opencode-go/gpt-6-luna",
  workerModel: "opencode/fledge-alpha-free",
  voice: "bm_george",
  followUp: "30",
  userName: "",
  onboarded: "off", // first-run setup wizard done
};

export function storePath() {
  if (process.env.JARVIS_SHELL_FILE) return process.env.JARVIS_SHELL_FILE;
  return path.join(os.homedir(), ".config", "jarvis", "shell.json");
}

function readFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function loadStore(file = storePath()) {
  const raw = readFile(file);
  const settings = { ...DEFAULTS, ...(raw?.settings ?? {}) };
  const audit = Array.isArray(raw?.audit) ? raw.audit : [];
  return { file, settings, audit };
}

function save(store) {
  fs.mkdirSync(path.dirname(store.file), { recursive: true });
  fs.writeFileSync(store.file, JSON.stringify({ settings: store.settings, audit: store.audit }, null, 2));
}

const KEY_OF = {
  "set.accent": "accent",
  "set.density": "density",
  "set.layout": "layout",
  "set.captionSize": "captionSize",
  "set.audioDevice": "audioDevice",
  "set.wake": "wake",
  "set.voiceMode": "voiceMode",
  "set.autoMode": "autoMode",
  "set.reviewMode": "reviewMode",
  "set.isolation": "isolation",
  "set.defaultAgent": "defaultAgent",
  "set.jarvisModel": "jarvisModel",
  "set.workerModel": "workerModel",
  "set.voice": "voice",
  "set.followUp": "followUp",
  "set.userName": "userName",
  "set.onboarded": "onboarded",
};
export const ON_OFF = ["on", "off"];
export const ISOLATIONS = ["worktree", "shared"];

export const validateAppCommand = (name, args) => validate(name, args);

function validate(name, args) {
  if (!ALLOWLIST.includes(name)) throw new Error(`not allowlisted: ${name}`);
  const value = args?.value;
  if (typeof value !== "string" || !value) throw new Error(`${name}: value required`);
  switch (name) {
    case "set.accent":
      if (!ACCENTS[value]) throw new Error(`unknown accent: ${value} (known: ${Object.keys(ACCENTS).join(", ")})`);
      break;
    case "set.density":
      if (!DENSITIES.includes(value)) throw new Error(`unknown density: ${value}`);
      break;
    case "set.layout":
      if (!LAYOUTS.includes(value)) throw new Error(`unknown layout: ${value}`);
      break;
    case "set.captionSize":
      if (!CAPTION_SIZES.includes(value)) throw new Error(`unknown caption size: ${value}`);
      break;
    case "set.audioDevice":
    case "set.wake":
      if (value.length > 64) throw new Error(`${name}: value too long`);
      break;
    case "set.voiceMode":
    case "set.autoMode":
    case "set.reviewMode":
      if (!ON_OFF.includes(value)) throw new Error(`${name}: want on|off`);
      break;
    case "set.voice":
      if (!VOICES.includes(value)) throw new Error(`unknown voice: ${value} (known: ${VOICES.join(", ")})`);
      break;
    case "set.userName":
      if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,47}$/u.test(value)) throw new Error(`${name}: letters, spaces, . ' - only (max 48)`);
      break;
    case "set.onboarded":
      if (!ON_OFF.includes(value)) throw new Error(`${name}: want on|off`);
      break;
    case "set.followUp":
      if (!FOLLOW_UPS.includes(value)) throw new Error(`${name}: want ${FOLLOW_UPS.join("|")}`);
      break;
    case "set.isolation":
      if (!ISOLATIONS.includes(value)) throw new Error(`${name}: want worktree|shared`);
      break;
    case "set.defaultAgent":
      if (!/^[a-z0-9-]{1,48}$/.test(value)) throw new Error(`${name}: bad agent id`);
      break;
    case "set.jarvisModel":
    case "set.workerModel":
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/\S+$/.test(value)) throw new Error(`${name}: want provider/id`);
      break;
  }
  return value;
}

// Apply now, persist now. Returns the audit entry. No server involved.
export function applyAppCommand(store, name, args) {
  const value = validate(name, args);
  const key = KEY_OF[name];
  store.settings[key] = value;
  const entry = {
    at: Date.now(),
    bucket: "shell",
    what: `${name} ${value}`,
    live: true,
    needsRestart: false,
    note: "applied next frame, no server involved",
  };
  store.audit.push(entry);
  save(store);
  return entry;
}

// Spoken or typed shell phrases. Exact, enumerable — never a model judgment.
export function matchAppCommand(text) {
  // Deck has one accent; "theme" is its alias ("set the theme to amber" applies).
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/\btheme\b/g, "accent");
  let m;
  if (t === "dim the fleet") return { name: "set.accent", args: { value: "dim" } };
  if ((m = t.match(/^(?:use|set)(?: the)? (amber|phosphor|ice|ember|dim)(?: accent)?$/))) {
    return { name: "set.accent", args: { value: m[1] } };
  }
  if ((m = t.match(/^set(?: the)? accent to (amber|phosphor|ice|ember|dim)$/))) {
    return { name: "set.accent", args: { value: m[1] } };
  }
  if ((m = t.match(/^set density to (comfortable|compact)$/))) {
    return { name: "set.density", args: { value: m[1] } };
  }
  if ((m = t.match(/^set layout to (deck|wide)$/))) {
    return { name: "set.layout", args: { value: m[1] } };
  }
  if ((m = t.match(/^(?:set )?caption size (?:to )?(small|medium|large)$/))) {
    return { name: "set.captionSize", args: { value: m[1] } };
  }
  if ((m = t.match(/^set audio device to (.+)$/)) || (m = t.match(/^use audio device (.+)$/))) {
    return { name: "set.audioDevice", args: { value: m[1].trim() } };
  }
  if ((m = t.match(/^set wake word to (.+)$/))) {
    return { name: "set.wake", args: { value: m[1].trim() } };
  }
  if ((m = t.match(/^(?:turn |set )?voice mode (on|off)$/))) {
    return { name: "set.voiceMode", args: { value: m[1] } };
  }
  if ((m = t.match(/^(?:turn |set )?auto mode (on|off)$/))) {
    return { name: "set.autoMode", args: { value: m[1] } };
  }
  if ((m = t.match(/^(?:turn |set )?review mode (on|off)$/))) {
    return { name: "set.reviewMode", args: { value: m[1] } };
  }
  // "use the george voice", "set voice to fable", "set voice to bm_lewis"
  if ((m = t.match(/^(?:use(?: the)? ([a-z_]+) voice|set(?: the)? voice to ([a-z_]+))$/))) {
    const want = m[1] ?? m[2];
    const id = VOICES.find((v) => v === want) ?? VOICES.find((v) => v.split("_")[1] === want);
    if (id) return { name: "set.voice", args: { value: id } };
  }
  // "call me Ajay", "my name is Ajay": the name Jarvis uses for the user.
  if ((m = String(text ?? "").trim().replace(/[.!]+$/, "").match(/^(?:call me|my name is) ([\p{L}][\p{L}\p{M} .'-]{0,47})$/iu))) {
    return { name: "set.userName", args: { value: m[1].trim() } };
  }
  // Conversation window: "turn conversation mode off", "set follow up to 60 seconds",
  // "keep listening for 2 minutes".
  if ((m = t.match(/^(?:turn |set )?conversation mode (on|off)$/))) {
    return { name: "set.followUp", args: { value: m[1] === "on" ? "30" : "off" } };
  }
  if ((m = t.match(/^(?:set (?:the )?follow ?up (?:window )?to|keep listening for) (\d+|one|two) (seconds?|minutes?)$/))) {
    const n = { one: 1, two: 2 }[m[1]] ?? Number(m[1]);
    const secs = String(m[2].startsWith("minute") ? n * 60 : n);
    if (FOLLOW_UPS.includes(secs)) return { name: "set.followUp", args: { value: secs } };
  }
  if ((m = t.match(/^set isolation to (worktree|shared)$/))) {
    return { name: "set.isolation", args: { value: m[1] } };
  }
  if (t === "use worktrees") return { name: "set.isolation", args: { value: "worktree" } };
  if (t === "work in my checkout") return { name: "set.isolation", args: { value: "shared" } };
  if ((m = t.match(/^set default agent to ([a-z0-9-]+)$/)) || (m = t.match(/^use ([a-z0-9-]+) as default agent$/))) {
    return { name: "set.defaultAgent", args: { value: m[1] } };
  }
  return null;
}
