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

async function configureA5Delivery(home) {
  const globalConfig = path.join(home, "global.gitconfig");
  git(home, ["config", "--file", globalConfig, "ai.projectFamily", "a5"]);
  git(home, ["config", "--file", globalConfig, "alias.pr", "!git-pr"]);
  return globalConfig;
}

async function installPullRequestCapture(home) {
  const bin = path.join(home, "bin");
  const marker = path.join(home, "pr-args.json");
  const executable = path.join(bin, "git-pr");
  await mkdir(bin);
  await writeFile(executable, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.ORCHARD_PR_MARKER, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(executable, 0o755);
  return {
    marker,
    environment: {
      ORCHARD_PR_MARKER: marker,
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}

test("delivers an ordinary local branch into trunk and removes the branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-branch-"));
  const repository = await createFeatureRepository(home);
  const featureTip = git(repository, ["rev-parse", "HEAD"]);

  const output = await runOrchard(repository, home, ["deliver", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const outcome = JSON.parse(output.stdout);
  assert.equal(outcome.delivery.status, "integrated");
  assert.equal(outcome.worktree.kind, "ordinary-branch");
  assert.equal(outcome.transition.kind, "none");
  assert.equal(git(repository, ["branch", "--show-current"]), "main");
  assert.equal(git(repository, ["rev-parse", "main"]), featureTip);
  assert.equal(git(repository, ["branch", "--list", "hh/local-feature"]), "");
});

test("reports uncommitted ordinary branch changes without integrating", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-branch-"));
  const repository = await createFeatureRepository(home);
  const trunkTip = git(repository, ["rev-parse", "main"]);
  await writeFile(path.join(repository, "untracked.txt"), "keep\n");

  const output = await runOrchard(repository, home, ["deliver", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const outcome = JSON.parse(output.stdout);
  assert.equal(outcome.delivery.status, "needs-commit");
  assert.equal(outcome.worktree.kind, "ordinary-branch");
  assert.equal(outcome.worktree.branch, "hh/local-feature");
  assert.match(outcome.commit.status, /\?\? untracked\.txt/);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
});

test("rebases a diverged ordinary branch before fast-forwarding trunk", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-branch-"));
  const repository = await createFeatureRepository(home);
  git(repository, ["switch", "main"]);
  await writeFile(path.join(repository, "trunk.txt"), "trunk\n");
  git(repository, ["add", "trunk.txt"]);
  git(repository, ["commit", "-m", "advance trunk"]);
  const trunkTip = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "hh/local-feature"]);

  const output = await runOrchard(repository, home, ["deliver", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(git(repository, ["rev-parse", "main^"]), trunkTip);
  assert.equal(git(repository, ["branch", "--show-current"]), "main");
});

test("keeps an ordinary branch when requested", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-branch-"));
  const repository = await createFeatureRepository(home);

  const output = await runOrchard(repository, home, ["deliver", "--keep", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(git(repository, ["branch", "--show-current"]), "main");
  assert.equal(git(repository, ["branch", "--list", "hh/local-feature"]), "hh/local-feature");
});

test("opens a pull-request form for a trusted A5 ordinary branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-branch-"));
  const repository = await createFeatureRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "origin", "main"]);
  git(repository, ["remote", "set-head", "origin", "main"]);
  const trunkTip = git(repository, ["rev-parse", "main"]);
  const globalConfig = await configureA5Delivery(home);
  const capture = await installPullRequestCapture(home);

  const output = await runOrchard(repository, home, ["deliver", "--json"], {
    globalConfig,
    environment: capture.environment,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  const outcome = JSON.parse(output.stdout);
  assert.equal(outcome.delivery.status, "pr-form-opened");
  assert.equal(outcome.delivery.strategy, "pull-request");
  assert.deepEqual(JSON.parse(await readFile(capture.marker, "utf8")), ["create", "--web", "--fill"]);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
  assert.equal(git(repository, ["branch", "--show-current"]), "hh/local-feature");
  await access(path.join(repository, "feature.txt"));
});

test("does not trust repository-local A5 classification", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-local-branch-"));
  const repository = await createFeatureRepository(home);
  git(repository, ["config", "ai.projectFamily", "a5"]);

  const output = await runOrchard(repository, home, ["deliver", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).delivery.strategy, "local");
  assert.equal(git(repository, ["branch", "--show-current"]), "main");
});
