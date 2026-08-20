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

async function createConvertedTask({ home, implicitBase = false, publishBase = false }) {
  const repository = path.join(home, "projects", "alpha");
  git(home, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "Orchard Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "initial"]);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  git(repository, ["remote", "set-head", "origin", "main"]);
  const mainTip = git(repository, ["rev-parse", "main"]);
  git(repository, ["switch", "--create", "release", "main"]);
  await writeFile(path.join(repository, "release.txt"), "release base\n");
  git(repository, ["add", "release.txt"]);
  git(repository, ["commit", "-m", "release base"]);
  if (publishBase) git(repository, ["push", "--set-upstream", "origin", "release"]);
  const createArguments = ["switch", "--create", "stacked"];
  if (!implicitBase) createArguments.push("release");
  git(repository, createArguments);
  await writeFile(path.join(repository, "stacked.txt"), "stacked feature\n");
  git(repository, ["add", "stacked.txt"]);
  git(repository, ["commit", "-m", "stacked feature"]);
  const featureTip = git(repository, ["rev-parse", "HEAD"]);
  const converted = await runOrchard(repository, home, ["convert", "Stacked", "--json"]);
  assert.equal(converted.exitCode, 0, converted.stderr);
  return {
    repository,
    task: JSON.parse(converted.stdout).worktree,
    featureTip,
    mainTip,
  };
}

async function runOrchard(cwd, home, args, options = {}) {
  const child = spawn("node", [CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: options.globalConfig ?? "/dev/null",
      ...options.environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { stdout, stderr, exitCode };
}

async function configurePullRequestCapture(home) {
  const globalConfig = path.join(home, "global.gitconfig");
  git(home, ["config", "--file", globalConfig, "orchard.deliveryStrategy", "pull-request"]);
  git(home, ["config", "--file", globalConfig, "alias.pr", "!git-pr"]);
  const bin = path.join(home, "bin");
  const marker = path.join(home, "pr-args.json");
  const executable = path.join(bin, "git-pr");
  await mkdir(bin);
  await writeFile(executable, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.ORCHARD_PR_MARKER, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(executable, 0o755);
  return {
    globalConfig,
    marker,
    environment: {
      ORCHARD_PR_MARKER: marker,
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}

test("pull-request delivery targets the base branch recorded during conversion", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-base-delivery-"));
  const { repository, task } = await createConvertedTask({ home, publishBase: true });
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].baseBranch, "release");
  git(repository, ["switch", "release"]);
  await writeFile(path.join(repository, "release-next.txt"), "advanced release base\n");
  git(repository, ["add", "release-next.txt"]);
  git(repository, ["commit", "-m", "advance release base"]);
  git(repository, ["push"]);
  git(repository, ["switch", "main"]);
  const capture = await configurePullRequestCapture(home);

  const output = await runOrchard(task.path, home, ["deliver", "--json"], capture);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(JSON.parse(await readFile(capture.marker, "utf8")), [
    "create", "--web", "--fill", "--base", "release",
  ]);
  assert.equal(git(task.path, ["rev-parse", "HEAD^"]), git(repository, ["rev-parse", "origin/release"]));
});

test("local delivery fast-forwards a converted task's base branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-base-delivery-"));
  const { repository, task, featureTip, mainTip } = await createConvertedTask({
    home,
    implicitBase: true,
  });

  const output = await runOrchard(repository, home, ["deliver", "stacked", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const outcome = JSON.parse(output.stdout);
  assert.equal(outcome.integration.baseBranch, "release");
  assert.equal(outcome.cleanup.status, "completed");
  assert.equal(git(repository, ["rev-parse", "release"]), featureTip);
  assert.equal(git(repository, ["rev-parse", "main"]), mainTip);
  assert.equal(git(repository, ["branch", "--show-current"]), "main");
  await assert.rejects(access(task.path), { code: "ENOENT" });
});
