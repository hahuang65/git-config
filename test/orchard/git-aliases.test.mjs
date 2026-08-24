import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.join(TEST_DIRECTORY, "../..");
const GIT_CONFIGURATION = path.join(REPOSITORY, "config");

function git(cwd, args, home) {
  const output = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(output.status, 0, output.stderr);
  return output.stdout.trim();
}

test("sync deletes gone branches while preserving branches active in linked worktrees", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "git-alias-home-"));
  const repository = await mkdtemp(path.join(tmpdir(), "git-alias-repository-"));
  const linkedWorktree = await mkdtemp(path.join(tmpdir(), "git-alias-worktree-"));

  git(repository, ["init", "--initial-branch=main"], home);
  git(repository, ["config", "user.name", "Test"], home);
  git(repository, ["config", "user.email", "test@example.com"], home);
  git(repository, ["commit", "--allow-empty", "--message=initial"], home);
  git(repository, ["remote", "add", "origin", repository], home);
  git(repository, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], home);
  git(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"], home);
  git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], home);
  git(repository, ["config", "branch.main.remote", "origin"], home);
  git(repository, ["config", "branch.main.merge", "refs/heads/main"], home);
  git(repository, ["branch", "linked-gone"], home);
  git(repository, ["config", "branch.linked-gone.remote", "origin"], home);
  git(repository, ["config", "branch.linked-gone.merge", "refs/heads/missing"], home);
  git(repository, ["worktree", "add", linkedWorktree, "linked-gone"], home);
  git(repository, ["branch", "unused-gone"], home);
  git(repository, ["config", "branch.unused-gone.remote", "origin"], home);
  git(repository, ["config", "branch.unused-gone.merge", "refs/heads/missing"], home);

  const output = spawnSync(
    "git",
    ["-c", `include.path=${GIT_CONFIGURATION}`, "sync"],
    { cwd: repository, env: { ...process.env, HOME: home }, encoding: "utf8" },
  );

  assert.equal(output.status, 0, output.stderr);
  assert.doesNotMatch(output.stderr, /error: branch '\+' not found/);
  assert.equal(git(repository, ["branch", "--show-current"], home), "main");
  assert.equal(git(linkedWorktree, ["branch", "--show-current"], home), "linked-gone");
  assert.equal(git(repository, ["branch", "--format=%(refname:short)"], home), "linked-gone\nmain");
});
