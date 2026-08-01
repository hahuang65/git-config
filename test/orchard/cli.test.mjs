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

async function writeProjectState(home, name, root) {
  const group = path.join(home, ".orchard", name);
  await mkdir(group, { recursive: true });
  await writeFile(
    path.join(group, "state.json"),
    JSON.stringify({ version: 1, project: { name, root }, slots: [] }),
  );
}

async function runOrchard(args = [], options = {}) {
  const child = spawn("node", [CLI_PATH, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.home ? { HOME: options.home } : {}) },
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

test("status inside a linked worktree resolves its registered main project", async () => {
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
  await writeProjectState(home, "alpha", repository);

  const output = await runOrchard(["status", "--json"], { cwd: linked, home });

  assert.equal(output.exitCode, 0);
  assert.deepEqual(JSON.parse(output.stdout).projects.map((project) => project.name), ["alpha"]);
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
