import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findMainProjectDirectory, runGit } from "../../orchard/runtime/git.mjs";

test("Git gateway bounds external command duration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orchard-git-"));

  await assert.rejects(
    runGit(directory, ["-c", "alias.pause=!sleep 1", "pause"], { timeout: 25 }),
    (error) => error.killed === true || error.signal === "SIGTERM",
  );
});

test("main project discovery resolves a submodule's real checkout from linked worktrees", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orchard-submodule-"));
  const source = path.join(directory, "source");
  const parent = path.join(directory, "parent");
  await runGit(directory, ["init", source]);
  await writeFile(path.join(source, "README.md"), "submodule\n");
  await runGit(source, ["add", "README.md"]);
  await runGit(source, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  await runGit(directory, ["init", parent]);
  await runGit(parent, ["-c", "protocol.file.allow=always", "submodule", "add", source, "child"]);
  await runGit(parent, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add child"]);
  const child = path.join(parent, "child");
  const linked = path.join(directory, "linked");
  await runGit(child, ["worktree", "add", "--detach", linked, "HEAD"]);

  assert.equal(await findMainProjectDirectory(child), await realpath(child));
  assert.equal(await findMainProjectDirectory(linked), await realpath(child));
});
