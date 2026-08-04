import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
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

async function writeProjectState(home, name, root, slots = []) {
  const group = path.join(home, ".orchard", name);
  await mkdir(group, { recursive: true });
  await writeFile(
    path.join(group, "state.json"),
    JSON.stringify({ version: 1, project: { name, root }, slots }),
  );
}

async function runOrchard(args = [], options = {}) {
  const child = spawn("node", [CLI_PATH, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.home ? { HOME: options.home } : {}), ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { stdout, stderr, exitCode };
}

test("top-level help documents every command and compatibility boundary", async () => {
  const output = await runOrchard(["--help"]);

  assert.equal(output.exitCode, 0);
  assert.equal(output.stderr, "");
  assert.match(output.stdout, /Usage: orchard \[command\]/);
  for (const command of ["new", "convert", "status", "enter", "merge", "recycle", "prune", "destroy"]) {
    assert.match(output.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.match(output.stdout, /Node\.js 22\+/);
  assert.match(output.stdout, /macOS and Linux/);
  assert.match(output.stdout, /--json/);
});

test("unknown commands fail with usage guidance", async () => {
  const output = await runOrchard(["plant"]);

  assert.equal(output.exitCode, 2);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /Unknown command: plant/);
  assert.match(output.stderr, /orchard --help/);
});

test("completion suggests top-level commands", async () => {
  const output = await runOrchard(["__complete"]);

  assert.deepEqual(output, {
    stdout: "new\nconvert\nstatus\nenter\nmerge\nrecycle\nprune\ndestroy\n",
    stderr: "",
    exitCode: 0,
  });
});

test("completion suggests active worktrees for worktree-targeting commands", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));
  const repository = path.join(home, "projects", "alpha");
  await mkdir(repository, { recursive: true });
  git(repository, ["init", "--initial-branch=main"]);
  await writeProjectState(home, "alpha", repository, [
    { lifecycle: "task", intent: "second-task", branch: "hh/second-task", path: "/second-task" },
    { lifecycle: "available", intent: null, branch: null, path: "/available" },
    { lifecycle: "task", intent: "first-task", branch: "hh/first-task", path: "/first-task" },
  ]);
  await writeProjectState(home, "beta", path.join(home, "projects", "beta"), [
    { lifecycle: "task", intent: "other-task", branch: "hh/other-task", path: "/other-task" },
  ]);

  for (const command of ["enter", "merge", "recycle"]) {
    const output = await runOrchard(["__complete", command], { cwd: repository, home });
    assert.deepEqual(output, {
      stdout: "first-task\nsecond-task\n",
      stderr: "",
      exitCode: 0,
    });
  }
});

test("completion suggests the current project for project-level commands", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));
  const repository = path.join(home, "projects", "alpha");
  await mkdir(repository, { recursive: true });
  git(repository, ["init", "--initial-branch=main"]);
  await writeProjectState(home, "alpha", repository);
  await writeProjectState(home, "beta", path.join(home, "projects", "beta"));

  for (const command of ["destroy", "prune"]) {
    const output = await runOrchard(["__complete", command], { cwd: repository, home });
    assert.deepEqual(output, {
      stdout: "alpha\n",
      stderr: "",
      exitCode: 0,
    });
  }
});

test("status help documents scope and output controls", async () => {
  const output = await runOrchard(["status", "--help"]);

  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /Usage: orchard status/);
  assert.match(output.stdout, /--all/);
  assert.match(output.stdout, /--json/);
  assert.match(output.stdout, /--refresh/);
  assert.match(output.stdout, /inside a Git repository/i);
  assert.match(output.stdout, /outside a Git repository/i);
});

test("every subcommand help is comprehensive and never mutates Orchard state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));
  const repository = path.join(home, "project");
  await mkdir(repository);
  git(repository, ["init", "--initial-branch=main"]);
  const expectedOptions = {
    new: ["<intent>", "--offline", "--print-path", "--json"],
    convert: ["<intent>", "--print-path", "--json"],
    status: ["--all", "--refresh", "--json"],
    enter: ["<intent>", "--share", "--owner-pid", "--release-owner", "--print-path", "--json"],
    merge: ["--keep", "--finalize", "--json"],
    recycle: ["<intent>", "--keep-branch", "--json"],
    prune: ["--apply", "--json"],
    destroy: ["--apply", "--allow-unlanded", "--allow-live-use", "--allow-unverifiable", "--delete-branches", "--json"],
  };

  for (const [command, options] of Object.entries(expectedOptions)) {
    const output = await runOrchard([command, "--help"], { cwd: repository, home });
    assert.equal(output.exitCode, 0, `${command} help exits successfully`);
    assert.equal(output.stderr, "", `${command} help has no error output`);
    assert.match(output.stdout, new RegExp(`Usage: orchard ${command}`));
    assert.match(output.stdout, /Safety:|Failure:/, `${command} help documents safety or failure behavior`);
    for (const option of options) assert.match(output.stdout, new RegExp(option.replaceAll("-", "\\-")));
  }
  await assert.rejects(stat(path.join(home, ".orchard")), { code: "ENOENT" });
});

test("bare invocation reports that an isolated home has no Orchard projects", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));

  const output = await runOrchard([], { cwd: home, home });

  assert.deepEqual(output, {
    stdout: "No Orchard projects.\n",
    stderr: "",
    exitCode: 0,
  });
});

test("status shows each project and its active worktrees", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));
  const alphaRoot = path.join(home, "projects", "alpha");
  const betaRoot = path.join(home, "projects", "beta");
  const activePath = path.join(home, ".orchard", "alpha", "active-task");
  await writeProjectState(home, "alpha", alphaRoot, [
    { lifecycle: "available", path: path.join(home, ".orchard", "alpha", "pool", "slot-1") },
    { lifecycle: "task", intent: "active-task", branch: "hh/active-task", path: activePath },
  ]);
  await writeProjectState(home, "beta", betaRoot);

  const output = await runOrchard(["status"], { cwd: home, home });

  assert.deepEqual(output, {
    stdout: [
      "alpha",
      `\tactive-task (${activePath}) [hh/active-task]`,
      "beta",
      "\tNo active worktrees.",
      "",
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  });
});

test("status inside a repository lists only active worktrees without a project heading", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));
  const repository = path.join(home, "projects", "alpha");
  const activePath = path.join(home, ".orchard", "alpha", "active-task");
  await mkdir(repository, { recursive: true });
  git(repository, ["init", "--initial-branch=main"]);
  await writeProjectState(home, "alpha", repository, [
    { lifecycle: "task", intent: "active-task", branch: "hh/active-task", path: activePath },
  ]);
  await writeProjectState(home, "beta", path.join(home, "projects", "beta"), [
    { lifecycle: "task", intent: "other-task", branch: "hh/other-task", path: "/other-task" },
  ]);

  const output = await runOrchard(["status"], { cwd: repository, home });

  assert.deepEqual(output, {
    stdout: `active-task (${activePath}) [hh/active-task]\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("status colors project and worktree names when color is enabled", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));
  const alphaRoot = path.join(home, "projects", "alpha");
  const activePath = path.join(home, ".orchard", "alpha", "active-task");
  await writeProjectState(home, "alpha", alphaRoot, [
    { lifecycle: "task", intent: "active-task", branch: "hh/active-task", path: activePath },
  ]);

  const output = await runOrchard(["status"], { cwd: home, home, env: { FORCE_COLOR: "1" } });

  assert.deepEqual(output, {
    stdout: `\u001b[1;36malpha\u001b[0m\n\t\u001b[1;32mactive-task\u001b[0m (${activePath}) [hh/active-task]\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("status emits a versioned machine-readable outcome", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));

  const output = await runOrchard(["status", "--json"], { cwd: home, home });

  assert.equal(output.exitCode, 0);
  assert.deepEqual(JSON.parse(output.stdout), {
    protocolVersion: 1,
    command: "status",
    projects: [],
  });
});

test("status inside a repository shows only the registered project group", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));
  const repository = path.join(home, "projects", "alpha");
  await mkdir(repository, { recursive: true });
  git(repository, ["init", "--initial-branch=main"]);
  for (const [name, root] of [["alpha", repository], ["beta", path.join(home, "projects", "beta")]]) {
    await writeProjectState(home, name, root);
  }

  const output = await runOrchard(["status", "--json"], { cwd: repository, home });

  assert.equal(output.exitCode, 0);
  assert.deepEqual(JSON.parse(output.stdout).projects.map((project) => project.name), ["alpha"]);
});

test("status inside a linked worktree omits its project heading", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));
  const repository = path.join(home, "projects", "alpha");
  const linked = path.join(home, "linked", "feature");
  await mkdir(repository, { recursive: true });
  git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "README.md"), "alpha\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  await mkdir(path.dirname(linked), { recursive: true });
  git(repository, ["worktree", "add", "--detach", linked, "HEAD"]);
  await writeProjectState(home, "alpha", repository, [
    { lifecycle: "task", intent: "feature", branch: "hh/feature", path: linked },
  ]);

  const output = await runOrchard(["status"], { cwd: linked, home });

  assert.deepEqual(output, {
    stdout: `feature (${linked}) [hh/feature]\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("status --all overrides repository scoping", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-home-"));
  const repository = path.join(home, "projects", "alpha");
  await mkdir(repository, { recursive: true });
  git(repository, ["init", "--initial-branch=main"]);
  await writeProjectState(home, "alpha", repository);
  await writeProjectState(home, "beta", path.join(home, "projects", "beta"));

  const output = await runOrchard(["status", "--all", "--json"], { cwd: repository, home });

  assert.equal(output.exitCode, 0);
  assert.deepEqual(JSON.parse(output.stdout).projects.map((project) => project.name), ["alpha", "beta"]);
});
