import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(TEST_DIRECTORY, "../../orchard/bin/orchard.mjs");

function git(cwd, args) {
  const output = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], { encoding: "utf8" });
  if (output.status !== 0) throw new Error(output.stderr);
  return output.stdout.trim();
}

async function createRepository(home, name = "alpha") {
  return createRepositoryAt(path.join(home, "projects", name));
}

async function createRepositoryAt(repository) {
  await mkdir(path.dirname(repository), { recursive: true });
  git(path.dirname(repository), ["init", "--initial-branch=main", repository]);
  await writeFile(path.join(repository, "README.md"), `${path.basename(repository)}\n`);
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  return repository;
}

async function runOrchard(cwd, home, args, extraEnvironment = {}) {
  const child = spawn("node", [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { stdout, stderr, exitCode };
}

test("offline acquisition creates a named task worktree from local trunk", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-new-"));
  const repository = await createRepository(home);

  const output = await runOrchard(repository, home, ["new", "Auth Redirect", "--offline", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(output.stderr, "");
  const acquired = JSON.parse(output.stdout);
  assert.equal(acquired.protocolVersion, 1);
  assert.equal(acquired.command, "new");
  assert.equal(acquired.project.name, "alpha");
  assert.equal(acquired.worktree.intent, "auth-redirect");
  assert.equal(acquired.worktree.branch, "auth-redirect");
  assert.equal(acquired.worktree.path, path.join(home, ".orchard", "alpha", "auth-redirect"));
  assert.equal(acquired.transition.kind, "enter-worktree");
  assert.equal(acquired.transition.targetPath, acquired.worktree.path);
  assert.equal(git(acquired.worktree.path, ["branch", "--show-current"]), "auth-redirect");
  assert.equal(git(acquired.worktree.path, ["rev-parse", "HEAD"]), git(repository, ["rev-parse", "main"]));
});

test("interactive offline acquisition opens a managed shell in the task worktree", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-new-"));
  const repository = await createRepository(home);
  const shell = path.join(home, "record-shell");
  const marker = path.join(home, "shell-cwd");
  await writeFile(shell, "#!/bin/sh\nprintf '%s' \"$PWD\" > \"$ORCHARD_TEST_MARKER\"\n");
  await chmod(shell, 0o700);

  const output = await runOrchard(repository, home, ["new", "Shell Task", "--offline"], {
    SHELL: shell,
    ORCHARD_TEST_MARKER: marker,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(await readFile(marker, "utf8"), await realpath(path.join(home, ".orchard", "alpha", "shell-task")));
});

test("path output does not open an interactive shell", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-new-"));
  const repository = await createRepository(home);
  const shell = path.join(home, "record-shell");
  const marker = path.join(home, "shell-opened");
  await writeFile(shell, "#!/bin/sh\nprintf opened > \"$ORCHARD_TEST_MARKER\"\n");
  await chmod(shell, 0o700);

  const output = await runOrchard(repository, home, ["new", "Path Task", "--offline", "--print-path"], {
    SHELL: shell,
    ORCHARD_TEST_MARKER: marker,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(output.stdout.trim(), path.join(home, ".orchard", "alpha", "path-task"));
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("a newly colliding repository receives a parent-qualified project group", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-new-"));
  const firstRepository = await createRepositoryAt(path.join(home, "team-one", "alpha"));
  const secondRepository = await createRepositoryAt(path.join(home, "team-two", "alpha"));
  const first = await runOrchard(firstRepository, home, ["new", "First Task", "--offline", "--json"]);

  const second = await runOrchard(secondRepository, home, ["new", "Second Task", "--offline", "--json"]);

  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(JSON.parse(first.stdout).project.name, "alpha");
  assert.equal(JSON.parse(second.stdout).project.name, "team-two-alpha");
  assert.equal(JSON.parse(second.stdout).worktree.path, path.join(home, ".orchard", "team-two-alpha", "second-task"));
});

test("invalid capacity fails before creating a project group or branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-new-"));
  const repository = await createRepository(home);

  const output = await runOrchard(repository, home, ["new", "Invalid Capacity", "--offline", "--json"], {
    ORCHARD_MAX_TREES: "0",
  });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /ORCHARD_MAX_TREES must be a positive integer/);
  await assert.rejects(access(path.join(home, ".orchard", "alpha")), { code: "ENOENT" });
  assert.equal(git(repository, ["branch", "--list", "invalid-capacity"]), "");
});

test("concurrent acquisitions preserve both unique task slots", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-new-"));
  const repository = await createRepository(home);

  const outputs = await Promise.all([
    runOrchard(repository, home, ["new", "Concurrent One", "--offline", "--json"]),
    runOrchard(repository, home, ["new", "Concurrent Two", "--offline", "--json"]),
  ]);

  for (const output of outputs) assert.equal(output.exitCode, 0, output.stderr);
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.deepEqual(state.slots.map((slot) => slot.intent).sort(), ["concurrent-one", "concurrent-two"]);
  assert.equal(new Set(state.slots.map((slot) => slot.id)).size, 2);
});

test("offline acquisition refuses to branch from a non-trunk checkout", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-new-"));
  const repository = await createRepository(home);
  const first = await runOrchard(repository, home, ["new", "Register Trunk", "--offline", "--json"]);
  assert.equal(first.exitCode, 0, first.stderr);
  git(repository, ["switch", "-c", "temporary-base"]);

  const output = await runOrchard(repository, home, ["new", "Second Task", "--offline", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /main project directory must have trunk 'main' checked out/);
  assert.equal(git(repository, ["branch", "--list", "second-task"]), "");
});

test("offline acquisition refuses a dirty main project directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-new-"));
  const repository = await createRepository(home);
  await writeFile(path.join(repository, "notes.txt"), "uncommitted\n");

  const output = await runOrchard(repository, home, ["new", "Dirty Trunk", "--offline", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /main project directory must be clean/);
  assert.equal(git(repository, ["branch", "--list", "dirty-trunk"]), "");
});

test("capacity rejects acquisition without evicting existing task worktrees", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-new-"));
  const repository = await createRepository(home);
  const environment = { ORCHARD_MAX_TREES: "2" };
  const first = await runOrchard(repository, home, ["new", "First Slot", "--offline", "--json"], environment);
  const second = await runOrchard(repository, home, ["new", "Second Slot", "--offline", "--json"], environment);

  const rejected = await runOrchard(repository, home, ["new", "Third Slot", "--offline", "--json"], environment);

  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /capacity of 2 reached/);
  await access(JSON.parse(first.stdout).worktree.path);
  await access(JSON.parse(second.stdout).worktree.path);
  assert.equal(git(repository, ["branch", "--list", "third-slot"]), "");
});
