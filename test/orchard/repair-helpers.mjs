import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(TEST_DIRECTORY, "../../orchard/bin/orchard.mjs");

export function git(cwd, args) {
  const output = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (output.status !== 0) throw new Error(output.stderr);
  return output.stdout.trim();
}

export async function createRepository(home) {
  const repository = path.join(home, "projects", "alpha");
  git(home, ["init", "--initial-branch=main", repository]);
  await writeFile(path.join(repository, "README.md"), "alpha\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  return repository;
}

export async function runOrchard(cwd, home, args) {
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

export async function createQuarantinedTask(repository, home, name = "Repair Me") {
  const created = await runOrchard(repository, home, ["new", name, "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  git(task.path, ["switch", "--create", "accidental-branch"]);
  const quarantined = await runOrchard(repository, home, ["status", "--refresh", "--json"]);
  assert.equal(quarantined.exitCode, 0, quarantined.stderr);
  const priorQuarantine = JSON.parse(quarantined.stdout).projects[0].slots[0].quarantine;
  git(task.path, ["switch", task.branch]);
  return { priorQuarantine, task };
}

export function assertSuccessfulRepair({ outcome, task, priorQuarantine, expectedCanonicalPath, expectedCommit }) {
  const repairedAt = outcome.repair.repairedAt;
  assert.deepEqual({
    protocolVersion: outcome.protocolVersion,
    command: outcome.command,
    worktree: outcome.worktree,
    priorQuarantine: outcome.repair.priorQuarantine,
    accidentalBranch: outcome.repair.accidentalBranch,
    dirty: outcome.repair.dirty,
    proof: outcome.repair.proof,
    repairedAtIsValid: Number.isFinite(Date.parse(repairedAt)),
  }, {
    protocolVersion: 1,
    command: "repair",
    worktree: task,
    priorQuarantine,
    accidentalBranch: "accidental-branch",
    dirty: true,
    proof: {
      canonicalPath: expectedCanonicalPath,
      assignedBranch: task.branch,
      observedBranch: task.branch,
      observedCommit: expectedCommit,
      matchingPathEntries: 1,
      matchingBranchEntries: 1,
    },
    repairedAtIsValid: true,
  });
  return repairedAt;
}

export async function snapshotGitState(repository, taskPath) {
  return {
    trackedFile: await readFile(path.join(taskPath, "README.md"), "utf8"),
    untrackedFile: await readFile(path.join(taskPath, "untracked.txt"), "utf8"),
    status: git(taskPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    index: git(taskPath, ["ls-files", "--stage"]),
    head: git(taskPath, ["rev-parse", "HEAD"]),
    symbolicHead: git(taskPath, ["symbolic-ref", "HEAD"]),
    refs: git(repository, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
    worktrees: git(repository, ["worktree", "list", "--porcelain"]),
  };
}
