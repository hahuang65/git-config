import { readGlobalAlias, runGit, runTrustedAlias } from "./git.mjs";

export async function createBranchBoundWorktree({ projectRoot, trunk, intent, worktreePath }) {
  const alias = await readGlobalAlias(projectRoot, "new");
  if (alias === undefined) {
    await runGit(projectRoot, ["worktree", "add", "-b", intent, worktreePath, trunk]);
    return intent;
  }
  await runGit(projectRoot, ["worktree", "add", "--detach", worktreePath, trunk]);
  return attachWithTrustedAlias({ projectRoot, trunk, intent, worktreePath, alias });
}

export async function attachTaskBranch({ projectRoot, trunk, intent, worktreePath }) {
  const alias = await readGlobalAlias(projectRoot, "new");
  if (alias === undefined) {
    await runGit(worktreePath, ["switch", "--create", intent, trunk]);
    return intent;
  }
  return attachWithTrustedAlias({ projectRoot, trunk, intent, worktreePath, alias });
}

async function attachWithTrustedAlias({ projectRoot, trunk, intent, worktreePath, alias }) {
  const existingBranches = new Set(await listBranches(projectRoot));
  await runTrustedAlias(worktreePath, "new", alias, [intent]);
  const { stdout: branch } = await runGit(worktreePath, ["branch", "--show-current"]);
  if (!branch || branch === trunk || existingBranches.has(branch)) {
    throw new Error("The trusted global git new alias did not create a new task branch");
  }
  const { stdout: taskTip } = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  const { stdout: trunkTip } = await runGit(projectRoot, ["rev-parse", trunk]);
  if (taskTip !== trunkTip) throw new Error("The trusted global git new alias did not branch from trunk");
  return branch;
}

async function listBranches(projectRoot) {
  const { stdout } = await runGit(projectRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return stdout ? stdout.split("\n") : [];
}
