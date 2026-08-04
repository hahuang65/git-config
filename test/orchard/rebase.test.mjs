import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  const { repository } = await createRemoteRepository(home);
  const task = await createTask(home, repository, "Conflicted Task");
  await commitFile(task.path, "README.md", "task change\n", "task conflict");
  const originalTaskTip = git(task.path, ["rev-parse", "HEAD"]);
  await commitFile(repository, "README.md", "trunk change\n", "trunk conflict");
  const originalTrunkTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(task.path, home, ["rebase", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /automatically aborted/);
  assert.equal(git(task.path, ["rev-parse", "HEAD"]), originalTaskTip);
  assert.equal(git(repository, ["rev-parse", "main"]), originalTrunkTip);
  assert.equal(git(task.path, ["status", "--porcelain"]), "");
});
