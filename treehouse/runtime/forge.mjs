import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FORGE_TIMEOUT_MS = 15_000;

export async function queryGitHubPullRequests({
  projectRoot,
  featureBranch,
  timeoutMs = FORGE_TIMEOUT_MS,
  environment = process.env,
}) {
  const { stdout } = await execFileAsync("gh", [
    "pr",
    "list",
    "--state",
    "all",
    "--head",
    featureBranch,
    "--json",
    "state,headRefOid,mergeCommit,url,mergedAt",
    "--limit",
    "50",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: environment,
  });
  return JSON.parse(stdout);
}
