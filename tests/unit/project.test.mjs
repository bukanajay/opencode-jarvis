import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectDir, setProject, recentProjects, onProjectChange, projectStateDir, readProjectState, writeProjectState, matchProjectCommand } from "../../apps/main/src/project.js";
import { loadProjectMemory, loadMemory, remember, recallAll, extractProjectCandidates } from "../../apps/main/src/brain/memory.js";
import { rehydrateWorkers, workers, snapshot } from "../../apps/main/src/fleet.js";
import { buildThinkPrompt } from "../../apps/main/src/brain/brain.js";
import { fakeClient } from "../helpers/fake-client.mjs";

const mk = (name) => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-proj-")), name);
  fs.mkdirSync(d);
  return d;
};

test("test env keeps state out of the home directory", () => {
  assert.ok(projectStateDir().startsWith(os.tmpdir()));
  assert.equal(projectDir(), path.resolve(process.env.JARVIS_PROJECT));
});

test("setProject: validates, records recents newest-first, notifies on change", () => {
  const a = mk("alpha");
  const b = mk("beta");
  const seen = [];
  const off = onProjectChange((dir) => seen.push(path.basename(dir)));
  setProject(a);
  setProject(b);
  setProject(b);
  off();
  assert.deepEqual(seen, ["alpha", "beta"]);
  assert.equal(projectDir(), b);
  assert.deepEqual(recentProjects().slice(0, 2).map((r) => r.name), ["beta", "alpha"]);
  assert.throws(() => setProject(path.join(a, "nope")), /not a directory/);
});

test("project state: per-directory, shallow-merged", () => {
  const a = mk("state");
  writeProjectState({ parentSessionID: "ses_1" }, a);
  writeProjectState({ chains: [] }, a);
  assert.deepEqual(readProjectState(a), { parentSessionID: "ses_1", chains: [] });
  assert.notEqual(projectStateDir(a), projectStateDir(mk("state")), "same name, different path, different state");
});

test("matchProjectCommand: explicit vs bare forms", () => {
  const recents = [{ dir: "/x/web-app", name: "web-app" }, { dir: "/x/api", name: "api" }];
  assert.deepEqual(matchProjectCommand("switch to project API", recents), { dir: "/x/api", name: "api" });
  assert.deepEqual(matchProjectCommand("open project web", recents), { dir: "/x/web-app", name: "web-app" });
  assert.match(matchProjectCommand("switch to project mobile", recents).error, /no recent project/);
  assert.deepEqual(matchProjectCommand("work on api", recents), { dir: "/x/api", name: "api" });
  assert.equal(matchProjectCommand("work on parser", recents), null, "bare form never swallows prompts");
  assert.equal(matchProjectCommand("refactor the api", recents), null);
});

test("project memory: separate store, recalled before global facts", async () => {
  const dir = mk("memproj");
  remember(loadProjectMemory(dir), "tests run with pnpm vitest");
  remember(loadMemory(), "user runs tests before every commit");
  const hits = await recallAll("how do I run the tests", 6, dir);
  assert.match(hits[0].text, /vitest/);
  assert.ok(hits.some((f) => /before every commit/.test(f.text)));
  assert.equal((await recallAll("vitest", 6, mk("other"))).some((f) => /vitest/.test(f.text)), false);
});

test("extractProjectCandidates", () => {
  assert.deepEqual(extractProjectCandidates("remember for this project that migrations live in db/"), ["migrations live in db/"]);
  assert.deepEqual(extractProjectCandidates("In this repo, remember the API is versioned"), ["the API is versioned"]);
  assert.deepEqual(extractProjectCandidates("remember that I like tea"), []);
});

test("rehydrateWorkers: rebuilds records from session metadata, filtered per project", async () => {
  workers.clear();
  const { client } = fakeClient({
    "session.list": () => ({ data: [
      { id: "w1", title: "t1", agent: "build", outcome: "succeeded", time: { created: 1, idle: 2 }, metadata: { jarvis: { task: "fix parser", chain: "w1", round: 2, project: "/p" } } },
      { id: "w2", title: "running", time: { created: 1 } },
      { id: "w3", time: { created: 1, archived: 5 } },
    ] }),
  });
  assert.equal(await rehydrateWorkers(client, "parent", "/p"), 2);
  const w1 = workers.get("w1");
  assert.deepEqual([w1.task, w1.state, w1.round, w1.chain], ["fix parser", "done", 2, "w1"]);
  assert.equal(workers.get("w2").state, "working");
  assert.equal(snapshot("/p").length, 2);
  assert.equal(snapshot("/elsewhere").length, 0);
  workers.clear();
});

test("buildThinkPrompt names the current project", () => {
  assert.match(buildThinkPrompt("hi", [], [], { dir: "/x/api", name: "api" }), /Current project: api \(\/x\/api\)/);
});
