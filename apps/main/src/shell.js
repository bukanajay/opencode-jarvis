// Shell settings: app-owned, next frame, no server involved.
// Allowlist enforced here. Widening rules live in Step 5, not here.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ALLOWLIST = ["set.accent", "set.density", "set.layout", "set.captionSize", "set.audioDevice", "set.wake"];

export const ACCENTS = {
  phosphor: "#c8f04a",
  amber: "#f5a623",
  ice: "#7dd3fc",
  ember: "#ff6b4a",
  dim: "#3a4543",
};
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
};

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
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
  return null;
}
