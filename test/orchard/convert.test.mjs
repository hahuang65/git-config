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

test("convert moves a clean local task branch into a managed worktree", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-convert-"));
  const repository = await createRemoteRepository(home);
  git(repository, ["switch", "-c", "feature/auth"]);
  await commitFile(repository, "auth.txt", "feature\n", "feature commit");
  const featureTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(repository, home, ["convert", "Auth Isolation", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const converted = JSON.parse(output.stdout);
  assert.equal(converted.protocolVersion, 1);
  assert.equal(converted.command, "convert");
  assert.equal(converted.worktree.intent, "auth-isolation");
  assert.equal(converted.worktree.branch, "feature/auth");
  assert.equal(git(converted.worktree.path, ["rev-parse", "HEAD"]), featureTip);
  assert.equal(git(converted.worktree.path, ["branch", "--show-current"]), "feature/auth");
  assert.equal(git(repository, ["branch", "--show-current"]), "main");
});

test("conversion failure restores the local task branch and reports the recoverable target", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-convert-"));
  const repository = await createRemoteRepository(home);
  git(repository, ["switch", "-c", "feature/recoverable"]);
  await commitFile(repository, "feature.txt", "recoverable\n", "feature commit");
  const featureTip = git(repository, ["rev-parse", "HEAD"]);
  const target = path.join(home, ".orchard", "alpha", "blocked-target");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "sentinel"), "keep\n");

  const output = await runOrchard(repository, home, ["convert", "Blocked Target", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /remains recoverable/);
  assert.match(output.stderr, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(git(repository, ["branch", "--show-current"]), "feature/recoverable");
  assert.equal(git(repository, ["rev-parse", "HEAD"]), featureTip);
  assert.equal(await readFile(path.join(target, "sentinel"), "utf8"), "keep\n");
});

test("conversion rejects trunk without creating Orchard state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-convert-"));
  const repository = await createRemoteRepository(home);

  const output = await runOrchard(repository, home, ["convert", "Not A Task", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /Cannot convert trunk 'main'/);
  assert.equal(git(repository, ["branch", "--show-current"]), "main");
  await assert.rejects(access(path.join(home, ".orchard", "alpha")), { code: "ENOENT" });
});

test("conversion rejects detached HEAD without mutation", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-convert-"));
  const repository = await createRemoteRepository(home);
  git(repository, ["switch", "--detach"]);
  const detachedTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(repository, home, ["convert", "Detached", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /named branch must be checked out/);
  assert.equal(git(repository, ["rev-parse", "HEAD"]), detachedTip);
  await assert.rejects(access(path.join(home, ".orchard", "alpha")), { code: "ENOENT" });
});

test("conversion rejects a branch already attached to a linked worktree", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-convert-"));
  const repository = await createRemoteRepository(home);
  const created = await runOrchard(repository, home, ["new", "Already Linked", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const taskPath = JSON.parse(created.stdout).worktree.path;

  const output = await runOrchard(taskPath, home, ["convert", "Again", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /must run from the main project directory/);
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.deepEqual(state.slots.map((slot) => slot.intent), ["already-linked"]);
});

test("dirty conversion preserves staged, unstaged, and untracked state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-convert-"));
  const repository = await createRemoteRepository(home);
  git(repository, ["switch", "-c", "feature/dirty"]);
  await commitFile(repository, "tracked.txt", "base\n", "feature base");
  await writeFile(path.join(repository, "README.md"), "staged\n");
  git(repository, ["add", "README.md"]);
  await writeFile(path.join(repository, "README.md"), "staged and unstaged\n");
  await writeFile(path.join(repository, "tracked.txt"), "unstaged\n");
  await writeFile(path.join(repository, "untracked.txt"), "untracked\n");
  const originalStatus = git(repository, ["status", "--porcelain=v1"]);

  const output = await runOrchard(repository, home, ["convert", "Dirty State", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const taskPath = JSON.parse(output.stdout).worktree.path;
  assert.equal(git(taskPath, ["status", "--porcelain=v1"]), originalStatus);
  assert.equal(git(taskPath, ["diff", "--cached", "--name-only"]), "README.md");
  assert.deepEqual(git(taskPath, ["diff", "--name-only"]).split("\n").sort(), ["README.md", "tracked.txt"]);
  assert.equal(await readFile(path.join(taskPath, "untracked.txt"), "utf8"), "untracked\n");
});

test("dirty conversion moves untracked files while leaving ignored files behind", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-convert-"));
  const repository = await createRemoteRepository(home);
  git(repository, ["switch", "-c", "feature/files"]);
  await commitFile(repository, ".gitignore", "ignored.cache\n", "ignore cache");
  await writeFile(path.join(repository, "untracked.txt"), "move me\n");
  await writeFile(path.join(repository, "ignored.cache"), "stay here\n");

  const output = await runOrchard(repository, home, ["convert", "File State", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const taskPath = JSON.parse(output.stdout).worktree.path;
  assert.equal(await readFile(path.join(taskPath, "untracked.txt"), "utf8"), "move me\n");
  await assert.rejects(access(path.join(repository, "untracked.txt")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(repository, "ignored.cache"), "utf8"), "stay here\n");
  await assert.rejects(access(path.join(taskPath, "ignored.cache")), { code: "ENOENT" });
});

test("restoration conflicts preserve recovery state and identify the stash", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-convert-"));
  const repository = await createRemoteRepository(home);
  git(repository, ["switch", "-c", "feature/conflict"]);
  await commitFile(repository, "tracked.txt", "base\n", "feature base");
  await writeFile(path.join(repository, "tracked.txt"), "dirty version\n");
  const hooks = path.join(home, "hooks");
  await mkdir(hooks);
  const hook = path.join(hooks, "post-checkout");
  await writeFile(hook, "#!/bin/sh\ncase \"$PWD\" in\n  */.orchard/*) printf 'conflicting commit\\n' > tracked.txt; git add tracked.txt; git -c user.name='Orchard Test' -c user.email=test@example.com commit -m conflict >/dev/null ;;\nesac\n");
  await chmod(hook, 0o700);
  git(repository, ["config", "core.hooksPath", hooks]);

  const output = await runOrchard(repository, home, ["convert", "Conflict State", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /needs recovery/);
  assert.match(output.stderr, /stash [0-9a-f]{40} was preserved/);
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].recovery.kind, "conversion");
  assert.equal(state.slots[0].recovery.status, "restoring");
  assert.equal(git(repository, ["rev-parse", "refs/stash"]), state.slots[0].recovery.stashOid);
});
