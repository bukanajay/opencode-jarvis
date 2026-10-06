// Preloaded by `npm test`: every Jarvis path points into a throwaway dir so
// unit tests never read or write ~/.config/jarvis.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
process.env.JARVIS_STATE_ROOT = path.join(root, "projects");
process.env.JARVIS_PROJECTS_FILE = path.join(root, "projects.json");
process.env.JARVIS_MEMORY_FILE ??= path.join(root, "memory.json");
process.env.JARVIS_SHELL_FILE = path.join(root, "shell.json");
process.env.JARVIS_WORKTREE_ROOT ??= path.join(root, "worktrees");
process.env.JARVIS_EMBED_OFF = "1";
process.env.JARVIS_PROJECT = root;
