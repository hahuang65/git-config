import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(TEST_DIRECTORY, "../../orchard/bin/orchard.mjs");

function git(cwd, args) {
  const output = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], { encoding: "utf8" });
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

async function createLandedTask(home, repository, intent = "Recyclable") {
  const created = await runOrchard(repository, home, ["new", intent, "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await writeFile(path.join(task.path, "feature.txt"), "land me\n");
  git(task.path, ["add", "feature.txt"]);
  git(task.path, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"]);
  git(repository, ["merge", "--ff-only", task.branch]);
  return task;
}

test("recycle turns a clean landed task into a detached available slot", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recycle-"));
  const repository = await createRepository(home);
  const task = await createLandedTask(home, repository);

  const output = await runOrchard(repository, home, ["recycle", "recyclable", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const recycled = JSON.parse(output.stdout);
  assert.equal(recycled.protocolVersion, 1);
  assert.equal(recycled.command, "recycle");
  assert.equal(recycled.slot.lifecycle, "available");
  assert.match(recycled.slot.path, /\/\.pool\//);
  await assert.rejects(access(task.path), { code: "ENOENT" });
  assert.equal(git(recycled.slot.path, ["branch", "--show-current"]), "");
  assert.equal(git(recycled.slot.path, ["rev-parse", "HEAD"]), git(repository, ["rev-parse", "main"]));
  assert.equal(git(repository, ["branch", "--list", task.branch]), "");
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].lifecycle, "available");
});

test("a later acquisition reuses the detached available slot", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recycle-"));
  const repository = await createRepository(home);
  await createLandedTask(home, repository);
  const recycledOutput = await runOrchard(repository, home, ["recycle", "recyclable", "--json"]);
  assert.equal(recycledOutput.exitCode, 0, recycledOutput.stderr);
  const recycled = JSON.parse(recycledOutput.stdout).slot;

  const acquiredOutput = await runOrchard(repository, home, ["new", "Reused Slot", "--offline", "--json"]);

  assert.equal(acquiredOutput.exitCode, 0, acquiredOutput.stderr);
  const acquired = JSON.parse(acquiredOutput.stdout).worktree;
  assert.equal(acquired.path, path.join(home, ".orchard", "alpha", "reused-slot"));
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots.length, 1);
  assert.equal(state.slots[0].id, recycled.id);
  assert.equal(state.slots[0].lifecycle, "task");
  assert.equal(state.slots[0].intent, "reused-slot");
  assert.equal(git(acquired.path, ["branch", "--show-current"]), "reused-slot");
});

test("recycle preserves an unlanded task worktree and branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recycle-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Unlanded", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await writeFile(path.join(task.path, "feature.txt"), "not landed\n");
  git(task.path, ["add", "feature.txt"]);
  git(task.path, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "unlanded"]);

  const output = await runOrchard(repository, home, ["recycle", "unlanded", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /not proven integrated.*or merged by pull request/);
  await access(task.path);
  assert.match(git(repository, ["branch", "--list", task.branch]), /unlanded$/);
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].lifecycle, "task");
});

test("recycle refuses a dirty landed task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recycle-"));
  const repository = await createRepository(home);
  const task = await createLandedTask(home, repository, "Dirty Landed");
  await writeFile(path.join(task.path, "dirty.txt"), "keep me\n");

  const output = await runOrchard(repository, home, ["recycle", "dirty-landed", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /task worktree must be clean/);
  assert.equal(await readFile(path.join(task.path, "dirty.txt"), "utf8"), "keep me\n");
});

test("recycle refuses a task with a live owner", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recycle-"));
  const repository = await createRepository(home);
  const task = await createLandedTask(home, repository, "Occupied");
  const entered = await runOrchard(repository, home, ["enter", "occupied", "--owner-pid", String(process.pid), "--json"]);
  assert.equal(entered.exitCode, 0, entered.stderr);

  const output = await runOrchard(repository, home, ["recycle", "occupied", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /is occupied/);
  await access(task.path);
});

test("recycle can retain the completed local branch explicitly", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recycle-"));
  const repository = await createRepository(home);
  const task = await createLandedTask(home, repository, "Keep Branch");

  const output = await runOrchard(repository, home, ["recycle", "keep-branch", "--keep-branch", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).removedBranch, null);
  assert.equal(git(repository, ["branch", "--list", task.branch]), task.branch);
});

test("recycle accepts exact-head squash landing proven by pull-request metadata", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recycle-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Squashed", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await writeFile(path.join(task.path, "squashed.txt"), "squash me\n");
  git(task.path, ["add", "squashed.txt"]);
  git(task.path, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"]);
  const featureTip = git(task.path, ["rev-parse", "HEAD"]);
  git(repository, ["merge", "--squash", task.branch]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "squash feature"]);
  const mergeCommit = git(repository, ["rev-parse", "HEAD"]);
  const bin = path.join(home, "bin");
  await mkdir(bin);
  const gh = path.join(bin, "gh");
  await writeFile(gh, `#!/bin/sh\nprintf '%s' '[{"state":"MERGED","headRefOid":"${featureTip}","mergeCommit":{"oid":"${mergeCommit}"},"url":"https://example.test/pull/1"}]'\n`);
  await chmod(gh, 0o700);

  const output = await runOrchard(repository, home, ["recycle", "squashed", "--json"], {
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).slot.lifecycle, "available");
});

test("recycle accepts an exact-head pull request merged into a non-trunk branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-recycle-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Release Branch", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await writeFile(path.join(task.path, "release.txt"), "merge into release\n");
  git(task.path, ["add", "release.txt"]);
  git(task.path, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"]);
  const featureTip = git(task.path, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "-c", "release"]);
  git(repository, ["merge", "--squash", task.branch]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "squash feature"]);
  const mergeCommit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "main"]);
  const bin = path.join(home, "bin");
  await mkdir(bin);
  const gh = path.join(bin, "gh");
  await writeFile(gh, `#!/bin/sh\nprintf '%s' '[{"state":"MERGED","headRefOid":"${featureTip}","mergeCommit":{"oid":"${mergeCommit}"},"url":"https://example.test/pull/2"}]'\n`);
  await chmod(gh, 0o700);

  const output = await runOrchard(repository, home, ["recycle", "release-branch", "--json"], {
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).slot.lifecycle, "available");
});
