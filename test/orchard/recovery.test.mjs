import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(TEST_DIRECTORY, "../../orchard/bin/orchard.mjs");

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
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  return repository;
}

async function runOrchard(cwd, home, args) {
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

test("refresh reconstructs known worktree facts from missing durable state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Recover Me", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  await unlink(statePath);

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const status = JSON.parse(output.stdout);
  assert.equal(status.projects[0].name, "alpha");
  assert.equal(status.projects[0].slots[0].lifecycle, "task");
  assert.equal(status.projects[0].slots[0].path, task.path);
  assert.equal(status.projects[0].slots[0].branch, task.branch);
  assert.equal(status.projects[0].slots[0].landing, "unknown");
  const reconstructed = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(reconstructed.slots[0].landing, "unknown");
});

test("refresh preserves live owners and releases only proven-dead owners", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Owned", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const finished = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = finished.pid;
  await new Promise((resolve) => finished.on("close", resolve));
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].owners = [
    { token: "live", pid: process.pid, shared: false },
    { token: "dead", pid: deadPid, shared: true },
  ];
  await writeFile(statePath, JSON.stringify(state));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const refreshed = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(refreshed.slots[0].owners.map((owner) => owner.token), ["live"]);
});

test("refresh quarantines conflicting branch registrations", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Conflicted", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const conflictedId = state.slots[0].id;
  state.slots[0].branch = "incorrect-branch";
  await writeFile(statePath, JSON.stringify(state));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const quarantined = JSON.parse(output.stdout).projects[0].slots[0];
  assert.equal(quarantined.lifecycle, "quarantined");
  assert.match(quarantined.quarantine.reason, /branch/i);
  const acquired = await runOrchard(repository, home, ["new", "Another", "--offline", "--json"]);
  assert.equal(acquired.exitCode, 0, acquired.stderr);
  const refreshed = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(refreshed.slots.find((slot) => slot.id === conflictedId).lifecycle, "quarantined");
  assert.equal(refreshed.slots.length, 2);
});

test("acquisition reconstructs truncated state before allocating another slot", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Existing", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  await writeFile(statePath, "{\"version\":1,");

  const acquired = await runOrchard(repository, home, ["new", "After Recovery", "--offline", "--json"]);

  assert.equal(acquired.exitCode, 0, acquired.stderr);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.slots.map((slot) => slot.intent).sort(), ["after-recovery", "existing"]);
  assert.equal(state.slots.find((slot) => slot.intent === "existing").landing, "unknown");
});

test("an interrupted temporary write cannot replace the last valid state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Atomic", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const original = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(`${statePath}.tmp-interrupted`, "{\"partial\":");

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), original);
  assert.equal(JSON.parse(output.stdout).projects[0].slots[0].intent, "atomic");
});
