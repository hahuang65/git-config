import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

test("status refresh records structured evidence when a task worktree breaks its branch binding", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Broken Binding", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  git(task.path, ["switch", "--create", "accidental-branch"]);
  const observedCommit = git(task.path, ["rev-parse", "HEAD"]);

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const slot = JSON.parse(output.stdout).projects[0].slots
    .find((candidate) => candidate.intent === task.intent);
  assert.deepEqual({
    lifecycle: slot.lifecycle,
    ...slot.quarantine,
    detectedAt: Number.isFinite(Date.parse(slot.quarantine.detectedAt)),
  }, {
    lifecycle: "quarantined",
    code: "branch-mismatch",
    reason: `Registered branch '${task.branch}' conflicts with Git branch 'accidental-branch'`,
    expectedBranch: task.branch,
    observedBranch: "accidental-branch",
    observedCommit,
    detectedAt: true,
  });
});

test("status refresh keeps quarantine durable after the expected branch is restored", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Durable", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  git(task.path, ["switch", "--create", "accidental-branch"]);
  const quarantined = await runOrchard(repository, home, ["status", "--refresh", "--json"]);
  assert.equal(quarantined.exitCode, 0, quarantined.stderr);
  git(task.path, ["switch", task.branch]);

  const restored = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(restored.exitCode, 0, restored.stderr);
  const slot = JSON.parse(restored.stdout).projects[0].slots[0];
  assert.deepEqual({ lifecycle: slot.lifecycle, quarantine: slot.quarantine }, {
    lifecycle: "quarantined",
    quarantine: JSON.parse(quarantined.stdout).projects[0].slots[0].quarantine,
  });
});

test("status refresh quarantines a stale Git worktree registration", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const stale = await runOrchard(repository, home, ["new", "Stale", "--offline", "--json"]);
  assert.equal(stale.exitCode, 0, stale.stderr);
  const staleTask = JSON.parse(stale.stdout).worktree;
  const second = await runOrchard(repository, home, ["new", "Metadata Reader", "--offline", "--json"]);
  assert.equal(second.exitCode, 0, second.stderr);
  await rm(staleTask.path, { recursive: true });

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const slot = JSON.parse(output.stdout).projects[0].slots.find((candidate) => candidate.intent === staleTask.intent);
  assert.deepEqual({ lifecycle: slot.lifecycle, code: slot.quarantine.code }, {
    lifecycle: "quarantined",
    code: "missing-worktree-metadata",
  });
});

test("status refresh quarantines a task without an assigned branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Missing Branch", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  git(task.path, ["switch", "--detach"]);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].branch = null;
  await writeFile(statePath, JSON.stringify(state));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const slot = JSON.parse(output.stdout).projects[0].slots[0];
  assert.deepEqual({ lifecycle: slot.lifecycle, code: slot.quarantine.code }, {
    lifecycle: "quarantined",
    code: "missing-task-branch",
  });
});

test("status refresh records a stable code for missing worktree metadata", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Missing", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].path = path.join(home, ".orchard", "alpha", "not-registered");
  await writeFile(statePath, JSON.stringify(state));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const quarantine = JSON.parse(output.stdout).projects[0].slots[0].quarantine;
  assert.deepEqual({ code: quarantine.code, detectedAt: Number.isFinite(Date.parse(quarantine.detectedAt)) }, {
    code: "missing-worktree-metadata",
    detectedAt: true,
  });
});

test("status refresh records a stable code when an available slot has a branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Available", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].lifecycle = "available";
  await writeFile(statePath, JSON.stringify(state));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(
    JSON.parse(output.stdout).projects[0].slots[0].quarantine.code,
    "available-branch-conflict",
  );
});

test("status refresh quarantines duplicate Git branch bindings", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Duplicate Git Binding", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  const duplicatePath = path.join(home, "linked", "duplicate-git-binding");
  git(repository, ["worktree", "add", "--force", duplicatePath, task.branch]);

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const slot = JSON.parse(output.stdout).projects[0].slots[0];
  assert.deepEqual({ lifecycle: slot.lifecycle, code: slot.quarantine.code }, {
    lifecycle: "quarantined",
    code: "duplicate-git-registration",
  });
});

test("status refresh records a stable code for duplicate registrations", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Duplicate", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots.push({ ...state.slots[0], id: "duplicate-slot" });
  await writeFile(statePath, JSON.stringify(state));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(
    JSON.parse(output.stdout).projects[0].slots.map((slot) => slot.quarantine.code),
    ["duplicate-registration", "duplicate-registration"],
  );
});

test("status refresh quarantines an active registration that duplicates an earlier quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Mixed Duplicate", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const actualSlot = state.slots[0];
  state.slots = [
    { ...actualSlot, id: "mismatched-duplicate", branch: "hh/wrong-branch" },
    { ...actualSlot, id: "matching-duplicate" },
  ];
  await writeFile(statePath, JSON.stringify(state));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(
    JSON.parse(output.stdout).projects[0].slots.map((slot) => ({
      lifecycle: slot.lifecycle,
      code: slot.quarantine.code,
    })),
    [
      { lifecycle: "quarantined", code: "branch-mismatch" },
      { lifecycle: "quarantined", code: "duplicate-registration" },
    ],
  );
});

test("status refresh quarantines a task registered in the available pool", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Wrong Valid Role", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  const poolPath = path.join(home, ".orchard", "alpha", ".pool", "wrong-valid-role");
  await mkdir(path.dirname(poolPath), { recursive: true });
  git(repository, ["worktree", "move", task.path, poolPath]);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].path = poolPath;
  await writeFile(statePath, JSON.stringify(state));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const slot = JSON.parse(output.stdout).projects[0].slots[0];
  assert.deepEqual({ lifecycle: slot.lifecycle, code: slot.quarantine.code }, {
    lifecycle: "quarantined",
    code: "managed-path-role-conflict",
  });
});

test("status refresh canonicalizes duplicate durable paths", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Canonical Duplicate", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  const poolDirectory = path.join(home, ".orchard", "alpha", ".pool");
  const poolPath = path.join(poolDirectory, "canonical-duplicate");
  const aliasPath = path.join(poolDirectory, "canonical-alias");
  await mkdir(poolDirectory, { recursive: true });
  git(task.path, ["switch", "--detach"]);
  git(repository, ["worktree", "move", task.path, poolPath]);
  await symlink(poolPath, aliasPath);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const available = { ...state.slots[0], lifecycle: "available", path: poolPath, intent: null, branch: null };
  state.slots = [available, { ...available, id: "canonical-alias", path: aliasPath }];
  await writeFile(statePath, JSON.stringify(state));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(
    JSON.parse(output.stdout).projects[0].slots.map((slot) => slot.quarantine.code),
    ["duplicate-registration", "duplicate-registration"],
  );
});

test("status refresh records a stable code for a reconstructed path-role conflict", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recovery-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Wrong Role", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  const group = path.join(home, ".orchard", "alpha");
  const poolPath = path.join(group, ".pool", "wrong-role");
  await mkdir(path.dirname(poolPath), { recursive: true });
  git(repository, ["worktree", "move", task.path, poolPath]);
  await unlink(path.join(group, "state.json"));

  const output = await runOrchard(repository, home, ["status", "--refresh", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(
    JSON.parse(output.stdout).projects[0].slots[0].quarantine.code,
    "reconstructed-role-conflict",
  );
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
