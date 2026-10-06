// Worktree isolation: every delegation chain works on its own branch in its
// own git worktree, so parallel workers never edit the same tree and nothing
// touches the user's checkout until they land it. Follow-ups and dispatches
// within a chain share its worktree (a reviewer sees the builder's changes).
//
// Git runs through an injectable runner so tests never need a real repo.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readProjectState, writeProjectState } from "./project.js";

export const chains = new Map(); // chainID -> { chainID, repo, base, branch, directory, state }

// Open chains are saved in the owning project's state.json so a restart can
// still land, keep or discard them.
function persist(project) {
  if (!project) return;
  const open = [...chains.values()].filter((c) => c.project === project && c.state === "open");
  try {
    writeProjectState({ chains: open }, project);
  } catch (err) {
    console.error("saving worktree chains failed:", err?.message ?? err);
  }
}

export function loadChains(project) {
  const saved = readProjectState(project).chains;
  let n = 0;
  for (const c of Array.isArray(saved) ? saved : []) {
    if (!c?.chainID || chains.has(c.chainID) || c.state !== "open" || !fs.existsSync(c.directory ?? "")) continue;
    chains.set(c.chainID, { ...c, project });
    n++;
  }
  return n;
}

export function defaultGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).trim()), { code: err.code }));
      else resolve(String(stdout).trim());
    });
  });
}

let git = defaultGit;
export function setGitRunner(fn) {
  git = fn ?? defaultGit;
}

export function worktreeRoot() {
  return process.env.JARVIS_WORKTREE_ROOT ?? path.join(os.homedir(), ".config", "jarvis", "worktrees");
}

// "Fix the flaky parser test!" -> "fix-the-flaky-parser-test"
export function branchSlug(task) {
  const s = String(task ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return s || "task";
}

export async function repoRoot(directory) {
  try {
    return await git(["rev-parse", "--show-toplevel"], directory);
  } catch {
    return null;
  }
}

// New chain → new branch + worktree off the repo's current HEAD. Returns null
// when the directory is not a git repo (caller falls back to shared mode).
export async function createChainWorktree(directory, task, chainID) {
  const repo = await repoRoot(directory);
  if (!repo) return null;
  const base = await git(["rev-parse", "--abbrev-ref", "HEAD"], repo).catch(() => "HEAD");
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const branch = `jarvis/${branchSlug(task)}-${id}`;
  const dir = path.join(worktreeRoot(), path.basename(repo), `${branchSlug(task)}-${id}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(["worktree", "add", "-b", branch, dir, "HEAD"], repo);
  const chain = { chainID: chainID ?? null, project: directory, repo, base, branch, directory: dir, state: "open", task: String(task ?? "") };
  if (chainID) bindChain(chainID, chain);
  return chain;
}

export function bindChain(chainID, chain) {
  chain.chainID = chainID;
  chains.set(chainID, chain);
  persist(chain.project);
  return chain;
}

async function commitAll(chain, message) {
  await git(["add", "-A"], chain.directory);
  const status = await git(["status", "--porcelain"], chain.directory);
  if (!status) return false;
  // The user's own identity when git has one; a local placeholder otherwise so
  // a fresh machine without user.email can still land.
  const email = await git(["config", "user.email"], chain.directory).catch(() => "");
  const who = email ? [] : ["-c", "user.name=Jarvis", "-c", "user.email=jarvis@localhost"];
  await git([...who, "commit", "-q", "-m", message], chain.directory);
  return true;
}

function commitMessage(chain) {
  const first = chain.task.split("\n")[0].slice(0, 72) || "jarvis changes";
  return `jarvis: ${first}`;
}

async function removeWorktree(chain, { deleteBranch }) {
  await git(["worktree", "remove", "--force", chain.directory], chain.repo).catch(() => {});
  await git(["worktree", "prune"], chain.repo).catch(() => {});
  if (deleteBranch) await git(["branch", "-D", chain.branch], chain.repo).catch(() => {});
}

// Commit the chain's work and merge it into the repo's checked-out branch.
// Refuses (and leaves everything as it was) when the user's checkout is dirty
// or not on the chain's base branch, or the merge conflicts.
export async function landChain(chainID) {
  const chain = chains.get(chainID);
  if (!chain || chain.state !== "open") throw new Error(`land: no open worktree for ${chainID}`);
  const committed = await commitAll(chain, commitMessage(chain));
  const ahead = Number(await git(["rev-list", "--count", `${chain.base}..${chain.branch}`], chain.repo).catch(() => "0"));
  if (!committed && ahead === 0) return { ok: false, reason: "nothing to land: the worker made no changes" };
  const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], chain.repo);
  if (current !== chain.base) return { ok: false, reason: `your checkout is on ${current}, not ${chain.base}; switch back or use keep` };
  if (await git(["status", "--porcelain", "--untracked-files=no"], chain.repo)) {
    return { ok: false, reason: "your checkout has uncommitted changes; commit or stash them, or use keep" };
  }
  try {
    await git(["merge", "--no-ff", "--no-edit", "-m", `Merge ${chain.branch}`, chain.branch], chain.repo);
  } catch (err) {
    await git(["merge", "--abort"], chain.repo).catch(() => {});
    return { ok: false, reason: `merge conflict, nothing changed: ${err.message.split("\n")[0]}` };
  }
  await removeWorktree(chain, { deleteBranch: true });
  chain.state = "landed";
  persist(chain.project);
  return { ok: true, action: "land", branch: chain.branch, base: chain.base };
}

// Commit the chain's work on its branch, drop the worktree, keep the branch
// for a PR or a later merge.
export async function keepChain(chainID) {
  const chain = chains.get(chainID);
  if (!chain || chain.state !== "open") throw new Error(`keep: no open worktree for ${chainID}`);
  await commitAll(chain, commitMessage(chain));
  await removeWorktree(chain, { deleteBranch: false });
  chain.state = "kept";
  persist(chain.project);
  return { ok: true, action: "keep", branch: chain.branch };
}

export async function discardChain(chainID) {
  const chain = chains.get(chainID);
  if (!chain || chain.state !== "open") throw new Error(`discard: no open worktree for ${chainID}`);
  await removeWorktree(chain, { deleteBranch: true });
  chain.state = "discarded";
  persist(chain.project);
  return { ok: true, action: "discard", branch: chain.branch };
}

export function publicChain(chain) {
  return chain ? { chainID: chain.chainID, branch: chain.branch, base: chain.base, directory: chain.directory, state: chain.state } : null;
}
