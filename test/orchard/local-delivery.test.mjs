import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  git(repository, ["config", "user.name", "Orchard Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(repository, "README.md"), "alpha\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  return repository;
}

async function runOrchard(cwd, home, args, extraEnvironment = {}) {
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

async function createTask(home, repository, intent = "Deliverable") {
  const created = await runOrchard(repository, home, ["new", intent, "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await writeFile(path.join(task.path, "feature.txt"), `${intent}\n`);
  git(task.path, ["add", "feature.txt"]);
  git(task.path, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"]);
  return task;
}

test("local delivery --keep fast-forwards trunk exactly to the feature tip", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository);
  const featureTip = git(task.path, ["rev-parse", "HEAD"]);

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const delivered = JSON.parse(output.stdout);
  assert.equal(delivered.protocolVersion, 1);
  assert.equal(delivered.command, "deliver");
  assert.equal(delivered.integration.status, "fast-forwarded");
  assert.equal(delivered.integration.strategy, "rebase");
  assert.equal(delivered.integration.tip, featureTip);
  assert.equal(delivered.cleanup.requested, false);
  assert.equal(git(repository, ["rev-parse", "main"]), featureTip);
  assert.equal(git(repository, ["rev-list", "--merges", "main"]).trim(), "");
  assert.equal(git(task.path, ["branch", "--show-current"]), task.branch);
  await access(task.path);
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].lifecycle, "task");
});

test("divergence rebases the task before fast-forwarding trunk", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Diverged");
  const originalFeatureTip = git(task.path, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repository, "trunk.txt"), "trunk change\n");
  git(repository, ["add", "trunk.txt"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "trunk change"]);
  const originalTrunkTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const rebasedFeatureTip = git(task.path, ["rev-parse", "HEAD"]);
  assert.notEqual(rebasedFeatureTip, originalFeatureTip);
  assert.equal(git(task.path, ["rev-parse", "HEAD^"]), originalTrunkTip);
  assert.equal(git(repository, ["rev-parse", "main"]), rebasedFeatureTip);
  assert.equal(git(repository, ["rev-list", "--merges", "main"]).trim(), "");
  assert.equal(git(task.path, ["branch", "--show-current"]), task.branch);
  await access(task.path);
});

test("a rebase conflict restores the task branch and leaves trunk unchanged", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Conflicted Rebase");
  await writeFile(path.join(task.path, "README.md"), "task change\n");
  git(task.path, ["add", "README.md"]);
  git(task.path, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "task conflict"]);
  const originalFeatureTip = git(task.path, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repository, "README.md"), "trunk change\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "trunk conflict"]);
  const originalTrunkTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /rebase.*conflict/i);
  assert.equal(git(repository, ["rev-parse", "main"]), originalTrunkTip);
  assert.equal(git(task.path, ["rev-parse", "HEAD"]), originalFeatureTip);
  assert.equal(git(task.path, ["branch", "--show-current"]), task.branch);
  assert.equal(git(task.path, ["status", "--porcelain"]), "");
  await access(task.path);
});

test("dirty main project state stops before integration", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Dirty Main");
  const originalTrunk = git(repository, ["rev-parse", "main"]);
  await writeFile(path.join(repository, "local.txt"), "do not touch\n");

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /main project directory must be clean/);
  assert.equal(git(repository, ["rev-parse", "main"]), originalTrunk);
  assert.equal(await readFile(path.join(repository, "local.txt"), "utf8"), "do not touch\n");
});

test("local delivery never pushes the fast-forwarded trunk", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const remoteTip = git(repository, ["rev-parse", "origin/main"]);
  const task = await createTask(home, repository, "Local Only");

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.notEqual(git(repository, ["rev-parse", "main"]), remoteTip);
  assert.equal(git(origin, ["rev-parse", "main"]), remoteTip);
});

test("local delivery refuses when trunk is not checked out in the main project directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Wrong Checkout");
  const trunkTip = git(repository, ["rev-parse", "main"]);
  git(repository, ["switch", "-c", "maintenance"]);

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /must have trunk 'main' checked out/);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
  assert.equal(git(repository, ["branch", "--show-current"]), "maintenance");
});

test("local delivery fast-forwards a behind trunk before rebasing the task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const task = await createTask(home, repository, "Stale Trunk");
  const updater = path.join(home, "updater");
  git(home, ["clone", origin, updater]);
  await writeFile(path.join(updater, "remote.txt"), "remote update\n");
  git(updater, ["add", "remote.txt"]);
  git(updater, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "remote update"]);
  git(updater, ["push"]);
  const remoteTip = git(updater, ["rev-parse", "HEAD"]);

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(git(task.path, ["rev-parse", "HEAD^"]), remoteTip);
  assert.equal(git(repository, ["rev-parse", "main"]), git(task.path, ["rev-parse", "HEAD"]));
});

test("local delivery accepts local trunk commits ahead of its upstream", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const task = await createTask(home, repository, "Ahead Trunk");
  await writeFile(path.join(repository, "local-main.txt"), "local main\n");
  git(repository, ["add", "local-main.txt"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "local main"]);
  const localMainTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(git(task.path, ["rev-parse", "HEAD^"]), localMainTip);
  assert.equal(git(repository, ["rev-parse", "main"]), git(task.path, ["rev-parse", "HEAD"]));
});

test("local delivery refuses when local trunk and its upstream have diverged", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const task = await createTask(home, repository, "Diverged Trunk");
  await writeFile(path.join(repository, "local-main.txt"), "local main\n");
  git(repository, ["add", "local-main.txt"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "local main"]);
  const localMainTip = git(repository, ["rev-parse", "HEAD"]);
  const updater = path.join(home, "updater");
  git(home, ["clone", origin, updater]);
  await writeFile(path.join(updater, "remote.txt"), "remote update\n");
  git(updater, ["add", "remote.txt"]);
  git(updater, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "remote update"]);
  git(updater, ["push"]);

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /diverged from 'origin\/main'/);
  assert.equal(git(repository, ["rev-parse", "main"]), localMainTip);
});

test("local delivery refuses divergence before invoking a rebase-capable sync alias", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const task = await createTask(home, repository, "Alias Divergence");
  await writeFile(path.join(repository, "local-main.txt"), "local main\n");
  git(repository, ["add", "local-main.txt"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "local main"]);
  const localMainTip = git(repository, ["rev-parse", "HEAD"]);
  const updater = path.join(home, "updater");
  git(home, ["clone", origin, updater]);
  await writeFile(path.join(updater, "remote.txt"), "remote update\n");
  git(updater, ["add", "remote.txt"]);
  git(updater, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "remote update"]);
  git(updater, ["push"]);
  const globalConfig = path.join(home, "global.gitconfig");
  const marker = path.join(home, "sync-alias-ran");
  git(home, ["config", "--file", globalConfig, "alias.sync", "!f() { printf invoked > \"$ORCHARD_SYNC_MARKER\"; git pull --rebase --autostash; }; f"]);

  const output = await runOrchard(task.path, home, ["deliver", "--keep", "--json"], {
    GIT_CONFIG_GLOBAL: globalConfig,
    ORCHARD_SYNC_MARKER: marker,
  });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /diverged from 'origin\/main'/);
  assert.equal(git(repository, ["rev-parse", "main"]), localMainTip);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("default local delivery finalizes recycling only after the caller returns to main", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Return Then Recycle");

  const deliveredOutput = await runOrchard(task.path, home, ["deliver", "--json"]);

  assert.equal(deliveredOutput.exitCode, 0, deliveredOutput.stderr);
  const delivered = JSON.parse(deliveredOutput.stdout);
  assert.equal(delivered.cleanup.requested, true);
  assert.equal(delivered.transition.kind, "return-main");
  await access(task.path);
  let state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].pendingCleanup.operationId, delivered.transition.operationId);
  assert.equal(state.slots[0].lifecycle, "task");

  const finalizedOutput = await runOrchard(repository, home, ["deliver", "--finalize", task.intent, "--json"]);

  assert.equal(finalizedOutput.exitCode, 0, finalizedOutput.stderr);
  const finalized = JSON.parse(finalizedOutput.stdout);
  assert.equal(finalized.cleanup.status, "completed");
  await assert.rejects(access(task.path), { code: "ENOENT" });
  state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].lifecycle, "available");
  assert.equal(git(repository, ["branch", "--list", task.branch]), "");
});

test("failed return preserves the landed task and pending cleanup", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Return Failure");
  const featureTip = git(task.path, ["rev-parse", "HEAD"]);
  const deliveredOutput = await runOrchard(task.path, home, ["deliver", "--json"]);
  assert.equal(deliveredOutput.exitCode, 0, deliveredOutput.stderr);
  const operationId = JSON.parse(deliveredOutput.stdout).transition.operationId;

  const failed = await runOrchard(task.path, home, ["deliver", "--finalize", task.intent, "--json"]);

  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /requires the caller to return to the main project directory/);
  assert.equal(git(repository, ["rev-parse", "main"]), featureTip);
  assert.equal(git(task.path, ["branch", "--show-current"]), task.branch);
  await access(task.path);
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].pendingCleanup.operationId, operationId);
});

test("cleanup failure never rolls trunk backward or removes an occupied task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Occupied Cleanup");
  const entered = await runOrchard(repository, home, ["enter", "occupied-cleanup", "--owner-pid", String(process.pid), "--json"]);
  assert.equal(entered.exitCode, 0, entered.stderr);
  const featureTip = git(task.path, ["rev-parse", "HEAD"]);
  const deliveredOutput = await runOrchard(task.path, home, ["deliver", "--json"]);
  assert.equal(deliveredOutput.exitCode, 0, deliveredOutput.stderr);
  const operationId = JSON.parse(deliveredOutput.stdout).transition.operationId;

  const failed = await runOrchard(repository, home, ["deliver", "--finalize", task.intent, "--json"]);

  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /is occupied/);
  assert.equal(git(repository, ["rev-parse", "main"]), featureTip);
  assert.equal(git(task.path, ["branch", "--show-current"]), task.branch);
  await access(task.path);
});

test("delivery cleanup finalization is idempotent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Idempotent Cleanup");
  const deliveredOutput = await runOrchard(task.path, home, ["deliver", "--json"]);
  assert.equal(deliveredOutput.exitCode, 0, deliveredOutput.stderr);
  const operationId = JSON.parse(deliveredOutput.stdout).transition.operationId;
  const first = await runOrchard(repository, home, ["deliver", "--finalize-operation", operationId, "--json"]);
  assert.equal(first.exitCode, 0, first.stderr);

  const second = await runOrchard(repository, home, ["deliver", "--finalize-operation", operationId, "--json"]);

  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).cleanup.status, "completed");
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots.length, 1);
  assert.equal(state.slots[0].lifecycle, "available");
  assert.equal(state.slots[0].completedCleanupOperationId, operationId);
});

test("managed shell delivery returns before outer cleanup recycles the task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-delivery-"));
  const repository = await createRepository(home);
  const shell = path.join(home, "managed-shell");
  await writeFile(shell, "#!/bin/sh\nprintf 'terminal feature\\n' > terminal.txt\ngit add terminal.txt\ngit -c user.name='Orchard Test' -c user.email=test@example.com commit -m 'terminal feature' >/dev/null\n\"$ORCHARD_EXECUTABLE\" deliver\n");
  await chmod(shell, 0o700);

  const output = await runOrchard(repository, home, ["new", "Terminal Return", "--offline"], {
    SHELL: shell,
    ORCHARD_EXECUTABLE: CLI_PATH,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /Fast-forwarded main/);
  assert.equal(await readFile(path.join(repository, "terminal.txt"), "utf8"), "terminal feature\n");
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].lifecycle, "available");
  assert.equal(git(repository, ["branch", "--list", "terminal-return"]), "");
});
