import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

async function commitFile(repository, filename, content, message) {
  await writeFile(path.join(repository, filename), content);
  git(repository, ["add", filename]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
}

async function createRemoteRepository(home) {
  const seed = path.join(home, "seed");
  const origin = path.join(home, "origin.git");
  const repository = path.join(home, "projects", "alpha");
  await mkdir(path.dirname(repository), { recursive: true });
  git(home, ["init", "--initial-branch=main", seed]);
  await commitFile(seed, "README.md", "initial\n", "initial");
  git(home, ["init", "--bare", "--initial-branch=main", origin]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "--set-upstream", "origin", "main"]);
  git(home, ["clone", origin, repository]);
  return { seed, origin, repository };
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

test("online acquisition fast-forwards trunk before creating the task branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-online-"));
  const { seed, repository } = await createRemoteRepository(home);
  await commitFile(seed, "remote.txt", "new remote work\n", "remote update");
  git(seed, ["push"]);
  const remoteTip = git(seed, ["rev-parse", "HEAD"]);

  const output = await runOrchard(repository, home, ["new", "Current Trunk", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const acquired = JSON.parse(output.stdout);
  assert.equal(git(repository, ["rev-parse", "main"]), remoteTip);
  assert.equal(git(acquired.worktree.path, ["rev-parse", "HEAD"]), remoteTip);
  assert.equal(git(acquired.worktree.path, ["branch", "--show-current"]), "current-trunk");
});

test("online acquisition uses a trusted global sync alias", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-online-"));
  const { seed, repository } = await createRemoteRepository(home);
  await commitFile(seed, "remote.txt", "new remote work\n", "remote update");
  git(seed, ["push"]);
  const globalConfig = path.join(home, "global.gitconfig");
  const marker = path.join(home, "sync-used");
  git(home, ["config", "--file", globalConfig, "alias.sync", "!f() { printf synced > \"$ORCHARD_SYNC_MARKER\" && git fetch --all --prune && git merge --ff-only '@{upstream}'; }; f"]);

  const output = await runOrchard(repository, home, ["new", "Alias Sync", "--json"], {
    GIT_CONFIG_GLOBAL: globalConfig,
    ORCHARD_SYNC_MARKER: marker,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(await readFile(marker, "utf8"), "synced");
  assert.equal(git(repository, ["rev-parse", "HEAD"]), git(seed, ["rev-parse", "HEAD"]));
});

test("online acquisition creates the task branch through a trusted global new alias", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-online-"));
  const { repository } = await createRemoteRepository(home);
  const globalConfig = path.join(home, "global.gitconfig");
  const marker = path.join(home, "new-used");
  git(home, ["config", "--file", globalConfig, "alias.new", "!f() { printf '%s' \"$1\" > \"$ORCHARD_NEW_MARKER\" && git switch --no-track --create \"team/$1\" main; }; f"]);

  const output = await runOrchard(repository, home, ["new", "Alias Branch", "--json"], {
    GIT_CONFIG_GLOBAL: globalConfig,
    ORCHARD_NEW_MARKER: marker,
  });

  assert.equal(output.exitCode, 0, output.stderr);
  const acquired = JSON.parse(output.stdout);
  assert.equal(await readFile(marker, "utf8"), "alias-branch");
  assert.equal(acquired.worktree.branch, "team/alias-branch");
  assert.equal(git(acquired.worktree.path, ["branch", "--show-current"]), "team/alias-branch");
  assert.equal(git(repository, ["branch", "--show-current"]), "main");
});

test("repository-local shell aliases are ignored during acquisition", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-online-"));
  const { repository } = await createRemoteRepository(home);
  const marker = path.join(home, "local-alias-ran");
  git(repository, ["config", "alias.sync", `!printf unsafe > '${marker}'; exit 91`]);
  git(repository, ["config", "alias.new", `!printf unsafe > '${marker}'; exit 92`]);

  const output = await runOrchard(repository, home, ["new", "Safe Fallback", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
  assert.equal(JSON.parse(output.stdout).worktree.branch, "safe-fallback");
});

test("a failing trusted sync alias stops without explicit fallback mutation", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-online-"));
  const { repository } = await createRemoteRepository(home);
  const globalConfig = path.join(home, "global.gitconfig");
  git(home, ["config", "--file", globalConfig, "alias.sync", "!f() { exit 23; }; f"]);

  const output = await runOrchard(repository, home, ["new", "Must Stop", "--json"], {
    GIT_CONFIG_GLOBAL: globalConfig,
  });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /sync/);
  await assert.rejects(access(path.join(home, ".orchard", "alpha")), { code: "ENOENT" });
  assert.equal(git(repository, ["branch", "--list", "must-stop"]), "");
});

test("a successful sync alias must still satisfy trunk postconditions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-online-"));
  const { seed, repository } = await createRemoteRepository(home);
  await commitFile(seed, "remote.txt", "new remote work\n", "remote update");
  git(seed, ["push"]);
  const globalConfig = path.join(home, "global.gitconfig");
  git(home, ["config", "--file", globalConfig, "alias.sync", "!f() { git fetch --all --prune; }; f"]);

  const output = await runOrchard(repository, home, ["new", "Stale Alias", "--json"], {
    GIT_CONFIG_GLOBAL: globalConfig,
  });

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /did not align 'main' with 'origin\/main'/);
  assert.equal(git(repository, ["branch", "--list", "stale-alias"]), "");
});

test("online acquisition resolves trunk from remote metadata instead of the current branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-online-"));
  const { repository } = await createRemoteRepository(home);
  git(repository, ["switch", "-c", "feature"]);
  git(repository, ["branch", "--set-upstream-to", "origin/main", "feature"]);

  const output = await runOrchard(repository, home, ["new", "Wrong Trunk", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /main project directory must have trunk 'main' checked out/);
  assert.equal(git(repository, ["branch", "--list", "wrong-trunk"]), "");
});
