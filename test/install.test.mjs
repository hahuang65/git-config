import assert from "node:assert/strict";
import { lstat, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));

test("A5 configuration retains project classification without Orchard policy", () => {
  const configuration = path.join(REPOSITORY, "a5.config");
  const family = spawnSync("git", ["config", "--file", configuration, "--get", "ai.projectFamily"], {
    encoding: "utf8",
  });
  assert.equal(family.status, 0, family.stderr);
  assert.equal(family.stdout.trim(), "a5");

  const policy = spawnSync("git", ["config", "--file", configuration, "--get-regexp", "^orchard\\."], {
    encoding: "utf8",
  });
  assert.equal(policy.status, 1, policy.stdout || policy.stderr);
});

test("installer links only Git configuration and is safe to repeat", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "git-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = spawnSync("sh", ["install.sh"], {
      cwd: REPOSITORY,
      env: { ...process.env, HOME: home, BASH_COMPLETION_USER_DIR: "", XDG_DATA_HOME: "" },
      encoding: "utf8",
    });
    assert.equal(output.status, 0, output.stderr);
  }

  for (const [link, target] of [
    [".gitconfig", "config"],
    [".a5.gitconfig", "a5.config"],
    [".gitignore_global", "ignore"],
    [".gitmessage", "message"],
  ]) {
    assert.equal(await readlink(path.join(home, link)), path.join(REPOSITORY, target));
  }
  await assert.rejects(lstat(path.join(home, ".local")), { code: "ENOENT" });
});
