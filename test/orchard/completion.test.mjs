import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const COMPLETION_PATH = path.join(TEST_DIRECTORY, "../../orchard/completions/orchard.bash");

test("Bash completion filters dynamic worktree candidates by the current word", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orchard-completion-"));
  const binDirectory = path.join(directory, "bin");
  const fakeOrchard = path.join(binDirectory, "orchard");
  await mkdir(binDirectory);
  await writeFile(fakeOrchard, "#!/bin/sh\nprintf 'other-task\\nstatus-output\\n'\n");
  await chmod(fakeOrchard, 0o755);

  const output = spawnSync("bash", ["-c", [
    "source \"$1\"",
    "COMP_WORDS=(orchard enter stat)",
    "COMP_CWORD=2",
    "_orchard_completion",
    "printf '%s\\n' \"${COMPREPLY[@]}\"",
  ].join("\n"), "completion-test", COMPLETION_PATH], {
    env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH}` },
    encoding: "utf8",
  });

  assert.deepEqual({ stdout: output.stdout, stderr: output.stderr, status: output.status }, {
    stdout: "status-output\n",
    stderr: "",
    status: 0,
  });
});
