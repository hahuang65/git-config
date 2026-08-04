import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.join(TEST_DIRECTORY, "../..");

test("A5 configuration selects one machine-readable project family and delivery strategy", async () => {
  const configuration = await readFile(path.join(REPOSITORY, "a5.config"), "utf8");

  assert.match(configuration, /\[ai\]\s+projectFamily = a5/);
  assert.match(configuration, /\[orchard\]\s+deliveryStrategy = pull-request/);
});

test("Git dotfiles installs the Orchard executable idempotently", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-install-"));
  const executableDirectory = path.join(home, ".local/bin");
  const legacyExecutable = path.join(executableDirectory, "treehouse");
  await mkdir(executableDirectory, { recursive: true });
  await symlink(path.join(REPOSITORY, "treehouse/bin/treehouse.mjs"), legacyExecutable);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = spawnSync("sh", ["install.sh"], {
      cwd: REPOSITORY,
      env: { ...process.env, HOME: home, BASH_COMPLETION_USER_DIR: "", XDG_DATA_HOME: "" },
      encoding: "utf8",
    });
    assert.equal(output.status, 0, output.stderr);
  }

  const executable = path.join(executableDirectory, "orchard");
  const completion = path.join(home, ".local/share/bash-completion/completions/orchard");
  assert.equal((await lstat(executable)).isSymbolicLink(), true);
  assert.equal(await readlink(executable), path.join(REPOSITORY, "orchard/bin/orchard.mjs"));
  assert.equal((await lstat(completion)).isSymbolicLink(), true);
  assert.equal(await readlink(completion), path.join(REPOSITORY, "orchard/completions/orchard.bash"));
  await assert.rejects(lstat(legacyExecutable), { code: "ENOENT" });
});
