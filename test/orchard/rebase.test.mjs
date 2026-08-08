import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

async function commitFile(repository, filename, content, message) {
  await writeFile(path.join(repository, filename), content);
  git(repository, ["add", filename]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
}

async function createRemoteRepository(home) {
  const seed = path.join(home, "seed");
  const origin = path.join(home, "origin.git");
  const repository = path.join(home, "projects", "alpha");
  await mkdir(path.dirname(repository), { recursive: true });
  git(home, ["init", "--initial-branch=main", seed]);
  await commitFile(seed, "README.md", "initial\n", "initial");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "--set-upstream", "origin", "main"]);
  git(home, ["clone", origin, repository]);
  git(repository, ["config", "user.name", "Orchard Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  return { origin, repository };
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

async function createTask(home, repository, intent) {
  const created = await runOrchard(repository, home, ["new", intent, "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await commitFile(task.path, "feature.txt", `${intent}\n`, "feature");
  return task;
}

async function pushRemoteCommit(home, origin) {
  const updater = path.join(home, "updater");
  git(home, ["clone", origin, updater]);
  await commitFile(updater, "remote.txt", "remote update\n", "remote update");
  git(updater, ["push"]);
  return git(updater, ["rev-parse", "HEAD"]);
}

async function createConflictedTask(home) {
  const { repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Resolvable Conflict");
  await commitFile(task.path, "README.md", "task change\n", "task conflict");
  const originalTaskTip = git(task.path, ["rev-parse", "HEAD"]);
  await commitFile(repository, "README.md", "trunk change\n", "trunk conflict");
  return { repository, task, originalTaskTip };
}

async function readProjectState(home) {
  return JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
}

test("rebase synchronizes a behind trunk before rebasing the active task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { origin, repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Current Trunk");
  const remoteTip = await pushRemoteCommit(home, origin);

  const output = await runOrchard(task.path, home, ["rebase", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const rebased = JSON.parse(output.stdout);
  assert.equal(rebased.command, "rebase");
  assert.equal(rebased.rebase.status, "rebased");
  assert.equal(git(repository, ["rev-parse", "main"]), remoteTip);
  assert.equal(git(task.path, ["rev-parse", "HEAD^"]), remoteTip);
});

test("a conflict-owning rebase accepts an already based task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Already Based");

  const output = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).rebase.status, "rebased");
  assert.equal((await readProjectState(home)).slots[0].recovery, undefined);
});

test("a conflict-owning rebase clears temporary recovery after success", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Owned Success");
  await commitFile(repository, "local-main.txt", "local main\n", "local main");

  const output = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).rebase.status, "rebased");
  assert.equal((await readProjectState(home)).slots[0].recovery, undefined);
});

test("rebase accepts a task worktree name from primary trunk", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Named Task");
  const originalTaskTip = git(task.path, ["rev-parse", "HEAD"]);
  await commitFile(repository, "local-main.txt", "local main\n", "local main");
  const trunkTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(repository, home, ["rebase", "named-task", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.notEqual(git(task.path, ["rev-parse", "HEAD"]), originalTaskTip);
  assert.equal(git(task.path, ["rev-parse", "HEAD^"]), trunkTip);
});

test("named rebase from primary trunk refuses an occupied task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Occupied Rebase");
  const taskTip = git(task.path, ["rev-parse", "HEAD"]);
  const entered = await runOrchard(repository, home, [
    "enter",
    task.intent,
    "--owner-pid",
    String(process.pid),
    "--json",
  ]);
  assert.equal(entered.exitCode, 0, entered.stderr);

  const output = await runOrchard(repository, home, ["rebase", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /is occupied/);
  assert.equal(git(task.path, ["rev-parse", "HEAD"]), taskTip);
});

test("rebase accepts local trunk commits ahead of its upstream", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Ahead Trunk");
  await commitFile(repository, "local-main.txt", "local main\n", "local main");
  const localMainTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(task.path, home, ["rebase", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(git(repository, ["rev-parse", "main"]), localMainTip);
  assert.equal(git(task.path, ["rev-parse", "HEAD^"]), localMainTip);
});

test("rebase refuses a dirty task before synchronizing trunk", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { origin, repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Dirty Task");
  const originalTaskTip = git(task.path, ["rev-parse", "HEAD"]);
  const originalTrunkTip = git(repository, ["rev-parse", "main"]);
  await pushRemoteCommit(home, origin);
  await writeFile(path.join(task.path, "dirty.txt"), "preserve me\n");

  const output = await runOrchard(task.path, home, ["rebase", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /task worktree must be clean/);
  assert.equal(git(task.path, ["rev-parse", "HEAD"]), originalTaskTip);
  assert.equal(git(repository, ["rev-parse", "main"]), originalTrunkTip);
});

test("rebase fetches a configured upstream whose tracking ref is missing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Missing Tracking Ref");
  git(repository, ["update-ref", "-d", "refs/remotes/origin/main"]);

  const output = await runOrchard(task.path, home, ["rebase", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(git(repository, ["rev-parse", "origin/main"]), git(repository, ["rev-parse", "main"]));
});

test("rebase refuses divergence before invoking a rebase-capable sync alias", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { origin, repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Alias Divergence");
  await commitFile(repository, "local-main.txt", "local main\n", "local main");
  const localMainTip = git(repository, ["rev-parse", "HEAD"]);
  await pushRemoteCommit(home, origin);
  const globalConfig = path.join(home, "global.gitconfig");
  const marker = path.join(home, "sync-alias-ran");
  git(home, ["config", "--file", globalConfig, "alias.sync", "!f() { printf invoked > \"$ORCHARD_SYNC_MARKER\"; git pull --rebase --autostash; }; f"]);

  const output = await runOrchard(task.path, home, ["rebase", "--json"], {
    GIT_CONFIG_GLOBAL: globalConfig,
    ORCHARD_SYNC_MARKER: marker,
  });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /diverged from 'origin\/main'/);
  assert.equal(git(repository, ["rev-parse", "main"]), localMainTip);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("a conflict restores the task while preserving synchronized trunk", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { origin, repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Remote Conflict");
  await commitFile(task.path, "README.md", "task change\n", "task conflict");
  const originalTaskTip = git(task.path, ["rev-parse", "HEAD"]);
  const updater = path.join(home, "updater-conflict");
  git(home, ["clone", origin, updater]);
  await commitFile(updater, "README.md", "remote change\n", "remote conflict");
  git(updater, ["push"]);
  const remoteTip = git(updater, ["rev-parse", "HEAD"]);

  const output = await runOrchard(task.path, home, ["rebase", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /task tip was restored.*synchronized trunk was preserved/i);
  assert.equal(git(task.path, ["rev-parse", "HEAD"]), originalTaskTip);
  assert.equal(git(repository, ["rev-parse", "main"]), remoteTip);
});

test("a rebase conflict restores the active task tip", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { repository, task, originalTaskTip } = await createConflictedTask(home);
  const originalTrunkTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(task.path, home, ["rebase", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /automatically aborted/);
  assert.equal(git(task.path, ["rev-parse", "HEAD"]), originalTaskTip);
  assert.equal(git(repository, ["rev-parse", "main"]), originalTrunkTip);
  assert.equal(git(task.path, ["status", "--porcelain"]), "");
});

test("a harness-owned rebase preserves conflicts with durable recovery metadata", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { task, originalTaskTip } = await createConflictedTask(home);

  const output = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const outcome = JSON.parse(output.stdout);
  assert.equal(outcome.rebase.status, "needs-conflict-resolution");
  assert.equal(outcome.rebase.originalTip, originalTaskTip);
  assert.match(outcome.rebase.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(git(task.path, ["diff", "--name-only", "--diff-filter=U"]), "README.md");
  const state = await readProjectState(home);
  assert.deepEqual(state.slots[0].recovery, {
    kind: "rebase",
    status: "conflicted",
    operationId: outcome.rebase.operationId,
    originalTip: outcome.rebase.originalTip,
    targetTip: outcome.rebase.targetTip,
    originalCommitCount: 2,
  });

  const refreshed = await runOrchard(task.path, home, ["status", "--refresh", "--json"]);
  assert.equal(refreshed.exitCode, 0, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).projects[0].slots[0].lifecycle, "task");
});

test("refresh quarantines a paused rebase whose target metadata changed", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { task } = await createConflictedTask(home);
  const started = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);
  const operation = JSON.parse(started.stdout).rebase;
  const ontoPath = git(task.path, ["rev-parse", "--git-path", "rebase-merge/onto"]);
  await writeFile(ontoPath, `${operation.originalTip}\n`);

  const refreshed = await runOrchard(task.path, home, ["status", "--refresh", "--json"]);

  assert.equal(refreshed.exitCode, 0, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).projects[0].slots[0].lifecycle, "quarantined");
});

test("refresh quarantines a paused rebase whose original-tip metadata changed", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { task } = await createConflictedTask(home);
  const started = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);
  const operation = JSON.parse(started.stdout).rebase;
  const originalHeadPath = git(task.path, ["rev-parse", "--git-path", "rebase-merge/orig-head"]);
  await writeFile(originalHeadPath, `${operation.targetTip}\n`);

  const refreshed = await runOrchard(task.path, home, ["status", "--refresh", "--json"]);

  assert.equal(refreshed.exitCode, 0, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).projects[0].slots[0].lifecycle, "quarantined");
});

test("finalizing an aborted Orchard rebase clears its recovery state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { task, originalTaskTip } = await createConflictedTask(home);
  const started = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);
  const operation = JSON.parse(started.stdout).rebase;
  git(task.path, ["rebase", "--abort"]);

  const finalized = await runOrchard(task.path, home, [
    "rebase",
    "--finalize-operation",
    operation.operationId,
    "--json",
  ]);

  assert.equal(finalized.exitCode, 0, finalized.stderr);
  assert.equal(JSON.parse(finalized.stdout).rebase.status, "aborted");
  assert.equal(git(task.path, ["rev-parse", "HEAD"]), originalTaskTip);
  assert.equal((await readProjectState(home)).slots[0].recovery, undefined);
});

test("a target-side conflict resolution keeps the replayed task commit", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { task } = await createConflictedTask(home);
  const started = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);
  const operation = JSON.parse(started.stdout).rebase;
  await writeFile(path.join(task.path, "README.md"), "trunk change\n");
  git(task.path, ["add", "README.md"]);
  git(task.path, ["commit", "--allow-empty", "--reuse-message=REBASE_HEAD"]);
  git(task.path, ["-c", "core.editor=true", "rebase", "--continue"]);

  const finalized = await runOrchard(task.path, home, [
    "rebase",
    "--finalize-operation",
    operation.operationId,
    "--json",
  ]);

  assert.equal(finalized.exitCode, 0, finalized.stderr);
  assert.equal(JSON.parse(finalized.stdout).rebase.status, "finalized");
  assert.equal(git(task.path, ["rev-list", "--count", `${operation.targetTip}..HEAD`]), "2");
});

test("finalization rejects a completed rebase that skipped a task commit", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { task } = await createConflictedTask(home);
  const started = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);
  const operation = JSON.parse(started.stdout).rebase;
  git(task.path, ["rebase", "--skip"]);

  const finalized = await runOrchard(task.path, home, [
    "rebase",
    "--finalize-operation",
    operation.operationId,
    "--json",
  ]);

  assert.equal(finalized.exitCode, 1);
  assert.match(finalized.stderr, /task commit count/);
  assert.equal((await readProjectState(home)).slots[0].recovery.operationId, operation.operationId);
});

test("finalization rejects an assigned branch reset that discards the task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { task } = await createConflictedTask(home);
  const started = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);
  const operation = JSON.parse(started.stdout).rebase;
  git(task.path, ["rebase", "--abort"]);
  git(task.path, ["reset", "--hard", operation.targetTip]);

  const finalized = await runOrchard(task.path, home, [
    "rebase",
    "--finalize-operation",
    operation.operationId,
    "--json",
  ]);

  assert.equal(finalized.exitCode, 1);
  assert.match(finalized.stderr, /task commit count|completed rebase/);
  assert.equal((await readProjectState(home)).slots[0].recovery.operationId, operation.operationId);
});

test("finalizing a resolved Orchard rebase clears its recovery state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { task } = await createConflictedTask(home);
  const started = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);
  const operation = JSON.parse(started.stdout).rebase;
  await writeFile(path.join(task.path, "README.md"), "trunk and task change\n");
  git(task.path, ["add", "README.md"]);
  git(task.path, ["-c", "core.editor=true", "rebase", "--continue"]);

  const finalized = await runOrchard(task.path, home, [
    "rebase",
    "--finalize-operation",
    operation.operationId,
    "--json",
  ]);

  assert.equal(finalized.exitCode, 0, finalized.stderr);
  const outcome = JSON.parse(finalized.stdout);
  assert.equal(outcome.rebase.status, "finalized");
  assert.equal(git(task.path, ["symbolic-ref", "--short", "HEAD"]), task.branch);
  assert.equal(git(task.path, ["status", "--porcelain"]), "");
  assert.equal((await readProjectState(home)).slots[0].recovery, undefined);

  const retried = await runOrchard(task.path, home, [
    "rebase",
    "--finalize-operation",
    operation.operationId,
    "--json",
  ]);
  assert.equal(retried.exitCode, 0, retried.stderr);
  assert.deepEqual(JSON.parse(retried.stdout), outcome);
  const completionPath = path.join(
    home,
    ".orchard",
    "alpha",
    "completed-rebases",
    `${operation.operationId}.json`,
  );
  const completion = JSON.parse(await readFile(completionPath, "utf8"));
  assert.equal(completion.operationId, operation.operationId);
  assert.deepEqual(completion.outcome.worktree, outcome.worktree);
});

test("conflict outcomes preserve filenames containing newlines", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-rebase-"));
  const { repository } = await createRemoteRepository(home);
  const filename = "line-one\nline-two.txt";
  await commitFile(repository, filename, "base\n", "newline base");
  const task = await createTask(home, repository, "Newline Conflict");
  await commitFile(task.path, filename, "task\n", "newline task");
  await commitFile(repository, filename, "trunk\n", "newline trunk");

  const output = await runOrchard(task.path, home, ["rebase", "--resolve-conflicts", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout).rebase.unresolved, [filename]);
});
