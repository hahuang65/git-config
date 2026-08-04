import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { commitArgumentsForStatus, promptToCommit } from "../../orchard/runtime/delivery-commit.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(TEST_DIRECTORY, "../../orchard/bin/orchard.mjs");

function git(cwd, args, environment = {}) {
  const output = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  if (output.status !== 0) throw new Error(output.stderr);
  return output.stdout.trim();
}

async function createRepository(home) {
  const repository = path.join(home, "projects", "alpha");
  await mkdir(path.dirname(repository), { recursive: true });
  git(home, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "Orchard Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "initial"]);
  return repository;
}

async function createTask(home, repository, intent = "Deliverable") {
  const created = await runOrchard(repository, home, ["new", intent, "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  await writeFile(path.join(task.path, "feature.txt"), `${intent}\n`);
  git(task.path, ["add", "feature.txt"]);
  git(task.path, ["commit", "-m", "feature"]);
  return task;
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
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(options.input ?? "");
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { stdout, stderr, exitCode };
}

async function configurePullRequestDelivery(home) {
  const globalConfig = path.join(home, "global.gitconfig");
  git(home, ["config", "--file", globalConfig, "orchard.deliveryStrategy", "pull-request"]);
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

test("machine delivery reports dirty changes without committing or integrating", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository);
  const trunkTip = git(repository, ["rev-parse", "main"]);
  await writeFile(path.join(task.path, "feature.txt"), "unstaged change\n");
  await writeFile(path.join(task.path, "untracked.txt"), "untracked\n");

  const output = await runOrchard(task.path, home, ["deliver", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const outcome = JSON.parse(output.stdout);
  assert.equal(outcome.delivery.status, "needs-commit");
  assert.match(outcome.commit.status, / M feature\.txt/);
  assert.match(outcome.commit.status, /\?\? untracked\.txt/);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
});

test("interactive delivery always shows dirty status and exits when commit is declined", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Declined Commit");
  await writeFile(path.join(task.path, "untracked.txt"), "preserve\n");

  const output = await runOrchard(task.path, home, ["deliver", "--keep"], { input: "n\n" });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /Uncommitted changes:/);
  assert.match(output.stdout, /\?\? untracked\.txt/);
  assert.match(output.stdout, /Delivery cancelled/);
  assert.equal(await readFile(path.join(task.path, "untracked.txt"), "utf8"), "preserve\n");
});

test("interactive delivery commits staged changes through the Git editor before delivery", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Staged Commit");
  await writeFile(path.join(task.path, "staged.txt"), "staged\n");
  git(task.path, ["add", "staged.txt"]);
  const editor = path.join(home, "commit-editor");
  await writeFile(editor, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "FEATURE: Commit staged delivery\\n\\nPrepare the task for delivery.\\n");\n`);
  await chmod(editor, 0o755);

  const output = await runOrchard(task.path, home, ["deliver", "--keep"], {
    input: "y\n",
    environment: { GIT_EDITOR: editor },
  });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /A  staged\.txt/);
  assert.match(output.stdout, /Fast-forwarded main/);
  assert.equal(git(task.path, ["status", "--porcelain"]), "");
  assert.equal(git(repository, ["rev-parse", "main"]), git(task.path, ["rev-parse", "HEAD"]));
});

test("unstaged or untracked changes open Git interactive staging while staged-only changes open the editor", () => {
  assert.deepEqual(commitArgumentsForStatus("M  staged.txt"), ["commit"]);
  assert.deepEqual(commitArgumentsForStatus(" M unstaged.txt"), ["commit", "--interactive"]);
  assert.deepEqual(commitArgumentsForStatus("?? untracked.txt"), ["commit", "--interactive"]);
});

test("accepting an untracked status prompt launches Git interactive commit", async () => {
  const commands = [];
  let displayed = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      displayed += chunk.toString();
      callback();
    },
  });

  const outcome = await promptToCommit({
    worktreePath: "/managed/task",
    status: "?? untracked.txt",
    input: Readable.from(["yes\n"]),
    output,
    runInteractive: async (_cwd, args) => commands.push(args),
    readStatus: async () => "",
  });

  assert.equal(outcome.status, "committed");
  assert.deepEqual(commands, [["commit", "--interactive"]]);
  assert.match(displayed, /\?\? untracked\.txt/);
});

test("named local delivery from primary trunk integrates and recycles immediately", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Named Delivery");
  const featureTip = git(task.path, ["rev-parse", "HEAD"]);

  const output = await runOrchard(repository, home, ["deliver", "named-delivery", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const outcome = JSON.parse(output.stdout);
  assert.equal(outcome.delivery.status, "integrated");
  assert.equal(outcome.cleanup.status, "completed");
  assert.equal(outcome.transition.kind, "none");
  assert.equal(git(repository, ["rev-parse", "main"]), featureTip);
  await assert.rejects(access(task.path), { code: "ENOENT" });
});

test("named local delivery refuses an occupied task before advancing trunk", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Occupied Named Delivery");
  const trunkTip = git(repository, ["rev-parse", "main"]);
  const entered = await runOrchard(repository, home, [
    "enter",
    task.intent,
    "--owner-pid",
    String(process.pid),
    "--json",
  ]);
  assert.equal(entered.exitCode, 0, entered.stderr);

  const output = await runOrchard(repository, home, ["deliver", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /is occupied/);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
  await access(task.path);
});

test("named --keep delivery also refuses an occupied task before advancing trunk", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Occupied Kept Delivery");
  const trunkTip = git(repository, ["rev-parse", "main"]);
  const entered = await runOrchard(repository, home, [
    "enter",
    task.intent,
    "--owner-pid",
    String(process.pid),
    "--json",
  ]);
  assert.equal(entered.exitCode, 0, entered.stderr);

  const output = await runOrchard(repository, home, ["deliver", task.intent, "--keep", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /is occupied/);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
  await access(task.path);
});

test("named delivery rejects an occupied dirty task before offering commit", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Occupied Dirty Delivery");
  const entered = await runOrchard(repository, home, [
    "enter",
    task.intent,
    "--owner-pid",
    String(process.pid),
    "--json",
  ]);
  assert.equal(entered.exitCode, 0, entered.stderr);
  await writeFile(path.join(task.path, "dirty.txt"), "dirty\n");

  const output = await runOrchard(repository, home, ["deliver", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /is occupied/);
});

test("named pull-request delivery rejects an occupied task before rebasing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Occupied Pull Request");
  const taskTip = git(task.path, ["rev-parse", "HEAD"]);
  const entered = await runOrchard(repository, home, [
    "enter",
    task.intent,
    "--owner-pid",
    String(process.pid),
    "--json",
  ]);
  assert.equal(entered.exitCode, 0, entered.stderr);
  const globalConfig = await configurePullRequestDelivery(home);

  const output = await runOrchard(repository, home, ["deliver", task.intent, "--json"], { globalConfig });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /is occupied/);
  assert.equal(git(task.path, ["rev-parse", "HEAD"]), taskTip);
});

test("manual local cleanup finalizes by worktree name while retaining an internal operation ID", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Manual Finalize");

  const delivered = await runOrchard(task.path, home, ["deliver", "--json"]);
  assert.equal(delivered.exitCode, 0, delivered.stderr);
  const operationId = JSON.parse(delivered.stdout).transition.operationId;

  const finalized = await runOrchard(repository, home, ["deliver", "--finalize", "manual-finalize", "--json"]);

  assert.equal(finalized.exitCode, 0, finalized.stderr);
  const outcome = JSON.parse(finalized.stdout);
  assert.equal(outcome.cleanup.status, "completed");
  assert.equal(outcome.cleanup.operationId, operationId);
  await assert.rejects(access(task.path), { code: "ENOENT" });
});

test("repository-local configuration cannot select a mutating delivery strategy", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Untrusted Policy");
  const trunkTip = git(repository, ["rev-parse", "main"]);
  git(repository, ["config", "orchard.deliveryStrategy", "pull-request"]);

  const output = await runOrchard(task.path, home, ["deliver", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /trusted user or system Git configuration/);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
});

test("command-scope configuration cannot select a mutating delivery strategy", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const task = await createTask(home, repository, "Command Policy");
  const trunkTip = git(repository, ["rev-parse", "main"]);

  const output = await runOrchard(task.path, home, ["deliver", "--json"], {
    environment: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "orchard.deliveryStrategy",
      GIT_CONFIG_VALUE_0: "pull-request",
    },
  });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /trusted user or system Git configuration/);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
});

test("pull-request delivery runs the exact Git PR command and retains the task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const task = await createTask(home, repository, "Pull Request");
  const trunkTip = git(repository, ["rev-parse", "main"]);
  const globalConfig = await configurePullRequestDelivery(home);
  const capture = await installPullRequestCapture(home);

  const output = await runOrchard(task.path, home, ["deliver", "--json"], {
    globalConfig,
    environment: capture.environment,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  const outcome = JSON.parse(output.stdout);
  assert.equal(outcome.delivery.status, "pr-form-opened");
  assert.equal(outcome.delivery.strategy, "pull-request");
  assert.deepEqual(JSON.parse(await readFile(capture.marker, "utf8")), ["create", "--web", "--fill"]);
  assert.equal(git(repository, ["rev-parse", "main"]), trunkTip);
  await access(task.path);
});

test("pull-request delivery pins the trusted global PR alias over repository configuration", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const task = await createTask(home, repository, "Trusted PR Alias");
  git(task.path, ["config", "alias.pr", "!false"]);
  const globalConfig = await configurePullRequestDelivery(home);
  const capture = await installPullRequestCapture(home);

  const output = await runOrchard(task.path, home, ["deliver", "--json"], {
    globalConfig,
    environment: capture.environment,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(JSON.parse(await readFile(capture.marker, "utf8")), ["create", "--web", "--fill"]);
});

test("pull-request delivery revalidates publication immediately before opening the form", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const task = await createTask(home, repository, "Publication Race");
  git(task.path, ["push", "--set-upstream", "origin", task.branch]);
  const updater = path.join(home, "updater");
  git(home, ["clone", origin, updater]);
  git(updater, ["switch", "--track", `origin/${task.branch}`]);
  await writeFile(path.join(updater, "raced.txt"), "remote race\n");
  git(updater, ["add", "raced.txt"]);
  git(updater, ["commit", "-m", "remote race"]);
  const raceScript = path.join(home, "push-race.mjs");
  await writeFile(raceScript, `import { spawnSync } from "node:child_process";\nconst pushed = spawnSync("git", ["-C", process.env.ORCHARD_RACE_REPO, "push"], { stdio: "inherit" });\nprocess.exitCode = pushed.status;\n`);
  const globalConfig = await configurePullRequestDelivery(home);
  git(home, ["config", "--file", globalConfig, "alias.sync", `!node ${raceScript}`]);
  const capture = await installPullRequestCapture(home);

  const output = await runOrchard(task.path, home, ["deliver", "--json"], {
    globalConfig,
    environment: { ...capture.environment, ORCHARD_RACE_REPO: updater },
  });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /Published branch changed during delivery/);
  await assert.rejects(access(capture.marker), { code: "ENOENT" });
});

test("pull-request delivery refuses a rewritten configured upstream", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const task = await createTask(home, repository, "Configured Upstream");
  git(task.path, ["push", "--set-upstream", "origin", task.branch]);
  await writeFile(path.join(repository, "trunk.txt"), "advance trunk\n");
  git(repository, ["add", "trunk.txt"]);
  git(repository, ["commit", "-m", "advance trunk"]);
  const globalConfig = await configurePullRequestDelivery(home);
  const capture = await installPullRequestCapture(home);

  const output = await runOrchard(task.path, home, ["deliver", "--json"], {
    globalConfig,
    environment: capture.environment,
  });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /published tip.*not an ancestor/i);
  await assert.rejects(access(capture.marker), { code: "ENOENT" });
});

test("pull-request delivery refuses a rewritten same-named published branch without upstream", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-deliver-"));
  const repository = await createRepository(home);
  const origin = path.join(home, "origin.git");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  const task = await createTask(home, repository, "Published Branch");
  git(task.path, ["push", "origin", `${task.branch}:${task.branch}`]);
  await writeFile(path.join(repository, "trunk.txt"), "advance trunk\n");
  git(repository, ["add", "trunk.txt"]);
  git(repository, ["commit", "-m", "advance trunk"]);
  const globalConfig = await configurePullRequestDelivery(home);
  const capture = await installPullRequestCapture(home);

  const output = await runOrchard(task.path, home, ["deliver", "--json"], {
    globalConfig,
    environment: capture.environment,
  });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /published tip.*not an ancestor/i);
  await assert.rejects(access(capture.marker), { code: "ENOENT" });
});
