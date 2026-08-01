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

async function createTwoAvailableSlots(home, repository) {
  const firstOutput = await runTreehouse(repository, home, ["new", "First", "--offline", "--json"]);
  const secondOutput = await runTreehouse(repository, home, ["new", "Second", "--offline", "--json"]);
  assert.equal(firstOutput.exitCode, 0, firstOutput.stderr);
  assert.equal(secondOutput.exitCode, 0, secondOutput.stderr);
  const first = JSON.parse(firstOutput.stdout).worktree;
  await writeFile(path.join(first.path, "first.txt"), "first\n");
  git(first.path, ["add", "first.txt"]);
  git(first.path, ["-c", "user.name=Treehouse Test", "-c", "user.email=test@example.com", "commit", "-m", "first"]);
  git(repository, ["merge", "--ff-only", first.branch]);
  const recycledFirst = await runTreehouse(repository, home, ["recycle", "first", "--json"]);
  const recycledSecond = await runTreehouse(repository, home, ["recycle", "second", "--json"]);
  assert.equal(recycledFirst.exitCode, 0, recycledFirst.stderr);
  assert.equal(recycledSecond.exitCode, 0, recycledSecond.stderr);
  return [JSON.parse(recycledFirst.stdout).slot.path, JSON.parse(recycledSecond.stdout).slot.path];
}

test("prune is a complete dry run by default", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-prune-"));
  const repository = await createRepository(home);
  const availablePaths = await createTwoAvailableSlots(home, repository);
  const statePath = path.join(home, ".treehouse", "alpha", "state.json");
  const originalState = await readFile(statePath, "utf8");

  const output = await runTreehouse(repository, home, ["prune", "--json"], { TREEHOUSE_MAX_TREES: "1" });

  assert.equal(output.exitCode, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.applied, false);
  assert.equal(result.plan.capacity, 1);
  assert.equal(result.plan.remove.length, 1);
  assert.equal(await readFile(statePath, "utf8"), originalState);
  for (const availablePath of availablePaths) await access(availablePath);
});

test("prune apply removes only available slots above capacity", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-prune-"));
  const repository = await createRepository(home);
  const availablePaths = await createTwoAvailableSlots(home, repository);

  const output = await runTreehouse(repository, home, ["prune", "--apply", "--json"], {
    TREEHOUSE_MAX_TREES: "1",
  });

  assert.equal(output.exitCode, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.applied, true);
  assert.equal(result.removed.length, 1);
  await assert.rejects(access(result.removed[0].path), { code: "ENOENT" });
  const preservedPath = availablePaths.find((candidate) => candidate !== result.removed[0].path);
  await access(preservedPath);
  const state = JSON.parse(await readFile(path.join(home, ".treehouse", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots.length, 1);
  assert.equal(state.slots[0].lifecycle, "available");
});

test("prune apply recycles eligible landed tasks before removing excess", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-prune-"));
  const repository = await createRepository(home);
  const landedOutput = await runTreehouse(repository, home, ["new", "Landed", "--offline", "--json"]);
  const activeOutput = await runTreehouse(repository, home, ["new", "Active", "--offline", "--json"]);
  assert.equal(landedOutput.exitCode, 0, landedOutput.stderr);
  assert.equal(activeOutput.exitCode, 0, activeOutput.stderr);
  const active = JSON.parse(activeOutput.stdout).worktree;
  await writeFile(path.join(active.path, "active.txt"), "not landed\n");
  git(active.path, ["add", "active.txt"]);
  git(active.path, ["-c", "user.name=Treehouse Test", "-c", "user.email=test@example.com", "commit", "-m", "active"]);

  const output = await runTreehouse(repository, home, ["prune", "--apply", "--json"], {
    TREEHOUSE_MAX_TREES: "1",
  });

  assert.equal(output.exitCode, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.deepEqual(result.plan.recycle.map((action) => action.intent), ["landed"]);
  assert.equal(result.removed.length, 1);
  const state = JSON.parse(await readFile(path.join(home, ".treehouse", "alpha", "state.json"), "utf8"));
  assert.deepEqual(state.slots.map((slot) => [slot.intent, slot.lifecycle]), [["active", "task"]]);
  await access(active.path);
});
