import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let wt;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-wt-unit-"));
const sh = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo);
  sh(["init", "-q", "-b", "main"], repo);
  sh(["config", "user.email", "dev@example.com"], repo);
  sh(["config", "user.name", "Dev"], repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  sh(["add", "-A"], repo);
  sh(["commit", "-q", "-m", "init"], repo);
  return repo;
}

before(async () => {
  process.env.JARVIS_WORKTREE_ROOT = path.join(tmp, "worktrees");
  wt = await import("../../apps/main/src/worktrees.js");
});

test("branchSlug", () => {
  assert.equal(wt.branchSlug("Fix the flaky parser test!"), "fix-the-flaky-parser-test");
  assert.equal(wt.branchSlug("???"), "task");
  assert.ok(wt.branchSlug("x".repeat(100)).length <= 32);
});

test("createChainWorktree: null outside a git repo", async () => {
  const plain = path.join(tmp, "plain");
  fs.mkdirSync(plain);
  assert.equal(await wt.createChainWorktree(plain, "t", "c0"), null);
});

test("land: worker changes merge into the user's branch, worktree and branch removed", async () => {
  const repo = makeRepo("land");
  const chain = await wt.createChainWorktree(repo, "Add b file", "c1");
  assert.equal(chain.base, "main");
  assert.match(chain.branch, /^jarvis\/add-b-file-/);
  fs.writeFileSync(path.join(chain.directory, "b.txt"), "two\n");
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), false, "user checkout untouched before land");
  const r = await wt.landChain("c1");
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "two\n");
  assert.equal(fs.existsSync(chain.directory), false);
  assert.equal(sh(["branch", "--list", chain.branch], repo), "");
  assert.match(sh(["log", "--format=%an %s"], repo), /Dev jarvis: Add b file/);
  await assert.rejects(wt.landChain("c1"), /no open worktree/);
});

test("land refuses a dirty checkout and leaves the worktree open", async () => {
  const repo = makeRepo("dirty");
  const chain = await wt.createChainWorktree(repo, "edit a", "c2");
  fs.writeFileSync(path.join(chain.directory, "a.txt"), "worker\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "user wip\n");
  const r = await wt.landChain("c2");
  assert.equal(r.ok, false);
  assert.match(r.reason, /uncommitted changes/);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "user wip\n");
  assert.equal(wt.chains.get("c2").state, "open");
});

test("land aborts cleanly on conflict", async () => {
  const repo = makeRepo("conflict");
  const chain = await wt.createChainWorktree(repo, "edit a", "c3");
  fs.writeFileSync(path.join(chain.directory, "a.txt"), "worker\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "user\n");
  sh(["commit", "-qam", "user edit"], repo);
  const r = await wt.landChain("c3");
  assert.equal(r.ok, false);
  assert.match(r.reason, /merge conflict/);
  assert.equal(sh(["status", "--porcelain"], repo), "");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "user\n");
});

test("land with no changes says so", async () => {
  const repo = makeRepo("empty");
  await wt.createChainWorktree(repo, "look around", "c4");
  const r = await wt.landChain("c4");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no changes/);
});

test("keep commits to the branch and removes only the worktree", async () => {
  const repo = makeRepo("keep");
  const chain = await wt.createChainWorktree(repo, "add c", "c5");
  fs.writeFileSync(path.join(chain.directory, "c.txt"), "c\n");
  const r = await wt.keepChain("c5");
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(chain.directory), false);
  assert.equal(sh(["show", `${chain.branch}:c.txt`], repo), "c");
  assert.equal(fs.existsSync(path.join(repo, "c.txt")), false);
});

test("discard drops worktree and branch", async () => {
  const repo = makeRepo("discard");
  const chain = await wt.createChainWorktree(repo, "junk", "c6");
  fs.writeFileSync(path.join(chain.directory, "junk.txt"), "x\n");
  assert.equal((await wt.discardChain("c6")).ok, true);
  assert.equal(fs.existsSync(chain.directory), false);
  assert.equal(sh(["branch", "--list", chain.branch], repo), "");
});

test("open chains persist in project state and reload after a restart", async () => {
  const { readProjectState } = await import("../../apps/main/src/project.js");
  const repo = makeRepo("persist");
  const chain = await wt.createChainWorktree(repo, "persist me", "c7");
  assert.deepEqual(readProjectState(repo).chains.map((c) => c.chainID), ["c7"]);
  wt.chains.delete("c7");
  assert.equal(wt.loadChains(repo), 1);
  assert.equal(wt.chains.get("c7").branch, chain.branch);
  await wt.discardChain("c7");
  assert.deepEqual(readProjectState(repo).chains, []);
  assert.equal(wt.loadChains(repo), 0);
});
