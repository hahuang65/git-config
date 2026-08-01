import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

async function runTreehouse(cwd, home, args, extraEnvironment = {}) {
  const child = spawn("node", [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { stdout, stderr, exitCode };
}

test("enter reopens a task worktree without changing its lifecycle identity", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-enter-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "Existing Task", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;

  const output = await runTreehouse(repository, home, ["enter", "existing-task", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const entered = JSON.parse(output.stdout);
  assert.equal(entered.protocolVersion, 1);
  assert.deepEqual(entered.worktree, task);
  assert.equal(entered.transition.kind, "enter-worktree");
  const state = JSON.parse(await readFile(path.join(home, ".treehouse", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].lifecycle, "task");
  assert.equal(state.slots[0].intent, "existing-task");
  assert.equal(state.slots[0].branch, "existing-task");
  assert.equal(git(task.path, ["branch", "--show-current"]), "existing-task");
});

test("managed shell entry releases its ownership claim when the shell exits", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-enter-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "Shell Entry", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const shell = path.join(home, "exit-shell");
  await writeFile(shell, "#!/bin/sh\nexit 0\n");
  await chmod(shell, 0o700);

  const output = await runTreehouse(repository, home, ["enter", "shell-entry"], { SHELL: shell });

  assert.equal(output.exitCode, 0, output.stderr);
  const state = JSON.parse(await readFile(path.join(home, ".treehouse", "alpha", "state.json"), "utf8"));
  assert.deepEqual(state.slots[0].owners, []);
});

test("a live exclusive owner blocks another caller", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-enter-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "Owned Task", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const first = await runTreehouse(repository, home, ["enter", "owned-task", "--owner-pid", String(process.pid), "--json"]);
  assert.equal(first.exitCode, 0, first.stderr);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  context.after(() => sleeper.kill());

  const blocked = await runTreehouse(repository, home, ["enter", "owned-task", "--owner-pid", String(sleeper.pid), "--json"]);

  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.stderr, /already in use/);
  assert.match(blocked.stderr, /--share/);
});

test("explicit shared entry records an independent live owner", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-enter-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "Shared Task", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const first = await runTreehouse(repository, home, ["enter", "shared-task", "--owner-pid", String(process.pid), "--json"]);
  assert.equal(first.exitCode, 0, first.stderr);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  context.after(() => sleeper.kill());

  const shared = await runTreehouse(repository, home, ["enter", "shared-task", "--owner-pid", String(sleeper.pid), "--share", "--json"]);

  assert.equal(shared.exitCode, 0, shared.stderr);
  const state = JSON.parse(await readFile(path.join(home, ".treehouse", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].owners.length, 2);
  assert.equal(state.slots[0].owners.find((owner) => owner.pid === sleeper.pid).shared, true);
});

test("a dead owner is cleared only after process liveness validation", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-enter-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "Stale Owner", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const finished = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = finished.pid;
  await new Promise((resolve) => finished.on("close", resolve));
  const statePath = path.join(home, ".treehouse", "alpha", "state.json");
  const staleState = JSON.parse(await readFile(statePath, "utf8"));
  staleState.slots[0].owners = [{ token: "stale", pid: deadPid, shared: false, claimedAt: new Date().toISOString() }];
  await writeFile(statePath, JSON.stringify(staleState));

  const output = await runTreehouse(repository, home, ["enter", "stale-owner", "--owner-pid", String(process.pid), "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const refreshed = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(refreshed.slots[0].owners.map((owner) => owner.pid), [process.pid]);
});

test("machine callers can release an ownership token after session shutdown", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-enter-"));
  const repository = await createRepository(home);
  const created = await runTreehouse(repository, home, ["new", "Release Owner", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const entered = await runTreehouse(repository, home, ["enter", "release-owner", "--owner-pid", String(process.pid), "--json"]);
  assert.equal(entered.exitCode, 0, entered.stderr);
  const ownerToken = JSON.parse(entered.stdout).owner.token;

  const released = await runTreehouse(repository, home, ["enter", "release-owner", "--release-owner", ownerToken, "--json"]);

  assert.equal(released.exitCode, 0, released.stderr);
  assert.equal(JSON.parse(released.stdout).released, true);
  const state = JSON.parse(await readFile(path.join(home, ".treehouse", "alpha", "state.json"), "utf8"));
  assert.deepEqual(state.slots[0].owners, []);
});
