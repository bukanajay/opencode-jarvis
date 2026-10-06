// Current project: the directory Jarvis reads, delegates into and remembers
// for. Replaces process.cwd() so the deck can switch projects without a
// relaunch. Recent projects and per-project state live under
// ~/.config/jarvis (JARVIS_PROJECTS_FILE / JARVIS_STATE_ROOT for tests).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const MAX_RECENT = 12;
let current = null;
const listeners = new Set();

function configRoot() {
  return path.join(os.homedir(), ".config", "jarvis");
}

export function projectsFile() {
  return process.env.JARVIS_PROJECTS_FILE ?? path.join(configRoot(), "projects.json");
}

function readProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(projectsFile(), "utf8"));
    return { last: typeof raw.last === "string" ? raw.last : null, recent: Array.isArray(raw.recent) ? raw.recent.filter((r) => typeof r?.dir === "string") : [] };
  } catch {
    return { last: null, recent: [] };
  }
}

function writeProjects(data) {
  fs.mkdirSync(path.dirname(projectsFile()), { recursive: true });
  fs.writeFileSync(projectsFile(), JSON.stringify(data, null, 2));
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// JARVIS_PROJECT wins, then (in the app only) the last project used if it
// still exists, then the launch directory. Scripts and tests never pick up
// the app's last project, so prove:* runs stay on the directory they run in.
export function projectDir() {
  if (current) return current;
  const env = process.env.JARVIS_PROJECT;
  const last = process.versions.electron ? readProjects().last : null;
  current = path.resolve([env, last].find((d) => d && isDir(d)) ?? process.cwd());
  return current;
}

export function projectName(dir = projectDir()) {
  return path.basename(dir) || dir;
}

export function recentProjects() {
  return readProjects().recent.filter((r) => isDir(r.dir));
}

export function setProject(dir) {
  const resolved = path.resolve(String(dir ?? ""));
  if (!dir || !isDir(resolved)) throw new Error(`not a directory: ${dir}`);
  const prev = current;
  current = resolved;
  const data = readProjects();
  data.last = resolved;
  data.recent = [{ dir: resolved, name: projectName(resolved), at: Date.now() }, ...data.recent.filter((r) => r.dir !== resolved)].slice(0, MAX_RECENT);
  writeProjects(data);
  if (prev !== resolved) for (const fn of listeners) { try { fn(resolved, prev); } catch {} }
  return { dir: resolved, name: projectName(resolved), changed: prev !== resolved };
}

export function onProjectChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Stable per-project folder for memory and state: <name>-<hash of path>.
export function projectStateDir(dir = projectDir()) {
  const root = process.env.JARVIS_STATE_ROOT ?? path.join(configRoot(), "projects");
  const hash = crypto.createHash("sha1").update(path.resolve(dir)).digest("hex").slice(0, 10);
  return path.join(root, `${projectName(dir).replace(/[^A-Za-z0-9._-]+/g, "-")}-${hash}`);
}

export function readProjectState(dir = projectDir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectStateDir(dir), "state.json"), "utf8")) ?? {};
  } catch {
    return {};
  }
}

// Shallow-merge a patch into the project's state.json.
export function writeProjectState(patch, dir = projectDir()) {
  const next = { ...readProjectState(dir), ...patch };
  fs.mkdirSync(projectStateDir(dir), { recursive: true });
  fs.writeFileSync(path.join(projectStateDir(dir), "state.json"), JSON.stringify(next, null, 2));
  return next;
}

// "switch to project api", "open project web-app", "work on jarvis". Matches
// recent project names only, exact (case-insensitive) first, then prefix.
export function matchProjectCommand(text, recents = recentProjects()) {
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  // Explicit "project" form reports unknown names; the bare form only fires on
  // an exact recent-project name so "work on parser" stays a normal prompt.
  const explicit = t.match(/^(?:switch to|open|work on|go to) (?:the )?project ([\w .-]{1,64})$/);
  const bare = explicit ? null : t.match(/^(?:switch to|work on) ([\w.-]{1,64})$/);
  if (!explicit && !bare) return null;
  const want = (explicit ?? bare)[1].trim();
  const named = recents.map((r) => ({ ...r, key: String(r.name ?? path.basename(r.dir)).toLowerCase() }));
  const hit = named.find((r) => r.key === want) ?? (explicit ? named.find((r) => r.key.startsWith(want)) : null);
  if (hit) return { dir: hit.dir, name: hit.name };
  return explicit ? { error: `no recent project named ${want}` } : null;
}
