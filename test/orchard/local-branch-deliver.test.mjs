import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

async function createFeatureRepository(home) {
  const repository = path.join(home, "projects", "alpha");
  await mkdir(path.dirname(repository), { recursive: true });
  git(home, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "Orchard Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "initial"]);
  git(repository, ["switch", "-c", "hh/local-feature"]);
  await writeFile(path.join(repository, "feature.txt"), "feature\n");
  git(repository, ["add", "feature.txt"]);
  git(repository, ["commit", "-m", "feature"]);
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

test("refuses delivery from an ordinary local branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-branch-"));
  const repository = await createFeatureRepository(home);
  const trunkTip = git(repository, ["rev-parse", "main"]);
  const featureTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(repository, home, ["deliver", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /no Orchard project group|managed task worktree/i);
  assert.equal(git(repository, ["branch", "--show-current"]), "hh/local-feature");
  assert.equal(git(repository, ["rev-parse", "HEAD"]), featureTip);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
});
