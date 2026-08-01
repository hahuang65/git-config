import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(TEST_DIRECTORY, "../../treehouse/bin/treehouse.mjs");

function git(cwd, args) {
  const output = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (output.status !== 0) throw new Error(output.stderr);
  return output.stdout.trim();
}

async function createRepository(home) {
  const repository = path.join(home, "projects", "alpha");
  git(home, ["init", "--initial-branch=main", repository]);
  await writeFile(path.join(repository, "README.md"), "alpha\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Treehouse Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  return repository;
}

async function runTreehouse(cwd, home, args) {
  const child = spawn("node", [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { stdout, stderr, exitCode };
}

test("destroy is a complete dry run by default", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-destroy-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "Unlanded", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await writeFile(path.join(task.path, "dirty.txt"), "keep\n");
  const statePath = path.join(home, ".treehouse", "alpha", "state.json");
  const originalState = await readFile(statePath, "utf8");

  const output = await runTreehouse(repository, home, ["destroy", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.applied, false);
  assert.equal(result.risks.unlanded, true);
  assert.deepEqual(result.plan.worktrees.map((worktree) => worktree.path), [task.path]);
  assert.deepEqual(result.plan.branches, [task.branch]);
  assert.equal(await readFile(statePath, "utf8"), originalState);
  assert.equal(await readFile(path.join(task.path, "dirty.txt"), "utf8"), "keep\n");
  await access(task.path);
});

test("destroy apply can remove unlanded work while retaining its local branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-destroy-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "Retain Branch", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await writeFile(path.join(task.path, "dirty.txt"), "authorized loss\n");

  const output = await runTreehouse(repository, home, ["destroy", "--apply", "--allow-unlanded", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).applied, true);
  await assert.rejects(access(task.path), { code: "ENOENT" });
  await assert.rejects(access(path.join(home, ".treehouse", "alpha")), { code: "ENOENT" });
  assert.match(git(repository, ["branch", "--list", task.branch]), /retain-branch$/);
});

test("destroy requires every matching risk gate independently", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-destroy-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "All Risks", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await writeFile(path.join(task.path, "dirty.txt"), "risk\n");
  const entered = await runTreehouse(repository, home, ["enter", "all-risks", "--owner-pid", String(process.pid), "--json"]);
  assert.equal(entered.exitCode, 0, entered.stderr);
  const statePath = path.join(home, ".treehouse", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].recovery = { kind: "test", status: "unknown" };
  await writeFile(statePath, JSON.stringify(state));

  const blocked = await runTreehouse(repository, home, ["destroy", "--apply", "--json"]);

  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.stderr, /--allow-unlanded/);
  assert.match(blocked.stderr, /--allow-live-use/);
  assert.match(blocked.stderr, /--allow-unverifiable/);
  await access(task.path);

  const allowed = await runTreehouse(repository, home, [
    "destroy", "--apply", "--allow-unlanded", "--allow-live-use", "--allow-unverifiable", "--json",
  ]);
  assert.equal(allowed.exitCode, 0, allowed.stderr);
  await assert.rejects(access(task.path), { code: "ENOENT" });
});

test("local branch deletion requires its separate explicit option", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-destroy-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "Delete Branch", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;

  const output = await runTreehouse(repository, home, ["destroy", "--apply", "--delete-branches", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout).deletedBranches, [task.branch]);
  assert.equal(git(repository, ["branch", "--list", task.branch]), "");
});

test("partial destroy failure keeps surviving work registered", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-destroy-"));
  const repository = await createRepository(home);
  const firstOutput = await runTreehouse(repository, home, ["new", "First", "--offline", "--json"]);
  const secondOutput = await runTreehouse(repository, home, ["new", "Second", "--offline", "--json"]);
  assert.equal(firstOutput.exitCode, 0, firstOutput.stderr);
  assert.equal(secondOutput.exitCode, 0, secondOutput.stderr);
  const first = JSON.parse(firstOutput.stdout).worktree;
  const second = JSON.parse(secondOutput.stdout).worktree;
  git(repository, ["worktree", "remove", second.path]);

  const output = await runTreehouse(repository, home, [
    "destroy", "--apply", "--allow-unlanded", "--allow-unverifiable", "--json",
  ]);

  assert.equal(output.exitCode, 1);
  await assert.rejects(access(first.path), { code: "ENOENT" });
  const state = JSON.parse(await readFile(path.join(home, ".treehouse", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots.length, 1);
  assert.equal(state.slots[0].intent, "second");
  assert.equal(state.slots[0].lifecycle, "quarantined");
});
