import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const DISABLE_FILE_SYSTEM_MONITOR_ARGS = ["-c", "core.fsmonitor=false"];

export async function runGit(cwd, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(
    "git",
    [...DISABLE_FILE_SYSTEM_MONITOR_ARGS, "-C", cwd, ...args],
    {
      encoding: "utf8",
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: options.env ?? process.env,
    },
  );
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

export async function runGitInteractive(cwd, args, options = {}) {
  const child = spawn("git", [...DISABLE_FILE_SYSTEM_MONITOR_ARGS, ...args], {
    cwd,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`Interactive Git command exited with status ${exitCode}`);
}

export async function readGlobalAlias(cwd, name) {
  try {
    const { stdout } = await runGit(cwd, ["config", "--global", "--get", `alias.${name}`]);
    return stdout;
  } catch (error) {
    if (error?.code === 1) return undefined;
    throw error;
  }
}

export async function runTrustedAlias(cwd, name, definition, args = [], options = {}) {
  return runGit(cwd, ["-c", `alias.${name}=${definition}`, name, ...args], options);
}

export async function findMainProjectDirectory(cwd) {
  try {
    const [{ stdout: commonDirectory }, { stdout: configuredWorktree }] = await Promise.all([
      runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      runGit(cwd, ["config", "--path", "core.worktree"]),
    ]);
    if (configuredWorktree) {
      return await realpath(path.resolve(commonDirectory, configuredWorktree));
    }
  } catch {
    // Ordinary repositories do not define core.worktree.
  }
  try {
    const { stdout } = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
    const firstField = stdout.split("\0", 1)[0];
    if (!firstField.startsWith("worktree ")) return undefined;
    return await realpath(firstField.slice("worktree ".length));
  } catch {
    return undefined;
  }
}

export async function findRemoteTrunk(cwd) {
  try {
    const { stdout } = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    return stdout.replace(/^[^/]+\//, "");
  } catch (error) {
    if (error?.code === 1) return undefined;
    throw error;
  }
}

export async function findRepositoryRoot(cwd) {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return await realpath(stdout);
  } catch {
    return undefined;
  }
}
