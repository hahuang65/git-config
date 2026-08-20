import { runGit } from "./git.mjs";
import { synchronizeTrunk } from "./synchronize.mjs";

const CREATION_PREFIX = "branch: Created from ";

export async function inferTaskBaseBranch({ projectRoot, taskBranch, trunk }) {
  const source = await readBranchCreationSource(projectRoot, taskBranch);
  if (!source) return trunk;
  const baseBranch = await normalizeBaseBranch(projectRoot, source);
  if (!baseBranch || baseBranch === taskBranch) return trunk;
  return baseBranch;
}

export async function resolveTaskBaseBranch(registry, slot) {
  if (slot.baseBranch) {
    await assertValidBranchName(registry.state.project.root, slot.baseBranch);
    return slot.baseBranch;
  }
  return inferTaskBaseBranch({
    projectRoot: registry.state.project.root,
    taskBranch: slot.branch,
    trunk: registry.state.project.trunk,
  });
}

export async function prepareTaskBase(registry, slot, { baseBranch, preferredRemote } = {}) {
  const resolvedBase = baseBranch ?? await resolveTaskBaseBranch(registry, slot);
  const { root: projectRoot, trunk } = registry.state.project;
  if (resolvedBase === trunk) {
    await synchronizeTrunk(projectRoot, trunk);
    return { branch: trunk, revision: trunk };
  }
  const remote = preferredRemote ?? await readConfiguredRemote(projectRoot, resolvedBase);
  if (!remote) return localBase(projectRoot, resolvedBase);
  const remoteReference = `refs/remotes/${remote}/${resolvedBase}`;
  await runGit(projectRoot, [
    "fetch", "--no-tags", remote,
    `refs/heads/${resolvedBase}:${remoteReference}`,
  ]);
  return { branch: resolvedBase, revision: remoteReference };
}

async function readBranchCreationSource(projectRoot, taskBranch) {
  try {
    const { stdout } = await runGit(projectRoot, [
      "reflog", "show", "--format=%gs", `refs/heads/${taskBranch}`,
    ]);
    const firstEntry = stdout.split("\n").at(-1);
    if (!firstEntry.startsWith(CREATION_PREFIX)) return undefined;
    const source = firstEntry.slice(CREATION_PREFIX.length);
    return source === "HEAD"
      ? readHeadCheckoutSource(projectRoot, taskBranch)
      : source;
  } catch {
    return undefined;
  }
}

async function readHeadCheckoutSource(projectRoot, taskBranch) {
  const { stdout } = await runGit(projectRoot, ["reflog", "show", "--format=%gs", "HEAD"]);
  const prefix = "checkout: moving from ";
  const suffix = ` to ${taskBranch}`;
  const matchingEntries = stdout.split("\n").filter((entry) =>
    entry.startsWith(prefix) && entry.endsWith(suffix));
  return matchingEntries.at(-1)?.slice(prefix.length, -suffix.length);
}

async function normalizeBaseBranch(projectRoot, source) {
  const remotes = await readRemotes(projectRoot);
  let branch = source;
  if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length);
  if (branch.startsWith("refs/remotes/")) branch = branch.slice("refs/remotes/".length);
  const remote = remotes.find((candidate) => branch.startsWith(`${candidate}/`));
  if (remote) branch = branch.slice(remote.length + 1);
  try {
    await assertValidBranchName(projectRoot, branch);
    return branch;
  } catch {
    return undefined;
  }
}

async function assertValidBranchName(projectRoot, branch) {
  await runGit(projectRoot, ["check-ref-format", "--branch", branch]);
}

async function readConfiguredRemote(projectRoot, branch) {
  try {
    const [{ stdout: remote }, { stdout: merge }] = await Promise.all([
      runGit(projectRoot, ["config", "--get", `branch.${branch}.remote`]),
      runGit(projectRoot, ["config", "--get", `branch.${branch}.merge`]),
    ]);
    return remote !== "." && merge === `refs/heads/${branch}` ? remote : undefined;
  } catch (error) {
    if (error?.code === 1) return undefined;
    throw error;
  }
}

async function readRemotes(projectRoot) {
  const { stdout } = await runGit(projectRoot, ["remote"]);
  return stdout ? stdout.split("\n") : [];
}

async function localBase(projectRoot, branch) {
  const revision = `refs/heads/${branch}`;
  await runGit(projectRoot, ["rev-parse", "--verify", `${revision}^{commit}`]);
  return { branch, revision };
}
