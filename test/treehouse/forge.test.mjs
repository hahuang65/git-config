import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { queryGitHubPullRequests } from "../../treehouse/runtime/forge.mjs";

test("GitHub metadata lookup obeys a bounded timeout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "treehouse-forge-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const gh = path.join(bin, "gh");
  await writeFile(gh, "#!/bin/sh\nsleep 1\nprintf '[]'\n");
  await chmod(gh, 0o700);

  await assert.rejects(
    queryGitHubPullRequests({
      projectRoot: directory,
      featureBranch: "feature",
      timeoutMs: 25,
      environment: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    }),
    (error) => error.killed === true || error.signal === "SIGTERM",
  );
});

test("GitHub metadata lookup uses only the read-only pull-request list command", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "treehouse-forge-"));
  const bin = path.join(directory, "bin");
  const marker = path.join(directory, "arguments");
  await mkdir(bin);
  const gh = path.join(bin, "gh");
  await writeFile(gh, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$GH_ARGUMENTS\"\nprintf '[]'\n");
  await chmod(gh, 0o700);

  const result = await queryGitHubPullRequests({
    projectRoot: directory,
    featureBranch: "feature/name",
    environment: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_ARGUMENTS: marker },
  });

  assert.deepEqual(result, []);
  assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
    "pr", "list", "--state", "all", "--head", "feature/name", "--json",
    "state,headRefOid,mergeCommit,url,mergedAt", "--limit", "50",
  ]);
});
