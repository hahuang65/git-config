import assert from "node:assert/strict";
import { lstat, mkdtemp, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.join(TEST_DIRECTORY, "../..");

test("Git dotfiles installs the Treehouse executable idempotently", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "treehouse-install-"));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = spawnSync("sh", ["install.sh"], {
      cwd: REPOSITORY,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(output.status, 0, output.stderr);
  }

  const executable = path.join(home, ".local/bin/treehouse");
  assert.equal((await lstat(executable)).isSymbolicLink(), true);
  assert.equal(await readlink(executable), path.join(REPOSITORY, "treehouse/bin/treehouse.mjs"));
});
