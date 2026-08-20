import { findRepositoryRoot, runGit } from "./git.mjs";
import { isTipAncestorOfTrunk } from "./landing.mjs";
import { pathsReferToSameLocation } from "./paths.mjs";
import { assertCleanWorktree, readCurrentBranch } from "./workspace-checks.mjs";

export async function resolveTaskSlot(registry, cwd, intent) {
  if (intent) {
    const slot = registry.state.slots.find((candidate) => candidate.lifecycle === "task" && candidate.intent === intent);
    if (!slot) throw new Error(`No managed task worktree matches '${intent}'`);
    return slot;
  }
  const checkoutRoot = await findRepositoryRoot(cwd);
  for (const slot of registry.state.slots.filter((candidate) => candidate.lifecycle === "task")) {
    if (checkoutRoot && await pathsReferToSameLocation(slot.path, checkoutRoot)) return slot;
  }
  throw new Error("Orchard integration requires a managed task worktree or explicit intent");
}

export async function validateTaskWorkspace(registry, slot) {
  const { root: projectRoot, trunk } = registry.state.project;
  if (slot.recovery) throw new Error(`Task worktree '${slot.intent}' has unresolved recovery state`);
  await assertCleanWorktree(slot.path, "task worktree");
  await assertCleanWorktree(projectRoot, "main project directory");
  const branch = await readCurrentBranch(projectRoot);
  if (branch !== trunk) throw new Error(`The main project directory must have trunk '${trunk}' checked out`);
  const taskBranch = await readCurrentBranch(slot.path);
  if (taskBranch !== slot.branch) throw new Error(`Task worktree must have branch '${slot.branch}' checked out`);
}

export async function rebaseTaskOntoTrunk(registry, slot) {
  const { trunk } = registry.state.project;
  return rebaseTaskOntoTarget(registry, slot, { branch: trunk, revision: trunk });
}

export async function rebaseTaskOntoTarget(registry, slot, target) {
  const { root: projectRoot } = registry.state.project;
  const { stdout: originalTip } = await runGit(slot.path, ["rev-parse", "HEAD"]);
  try {
    await runGit(slot.path, ["rebase", target.revision]);
  } catch (error) {
    await abortFailedRebase(
      slot.path,
      originalTip,
      target.branch,
      registry.state.project.trunk,
      error,
    );
  }
  if (!await isTipAncestorOfTrunk(projectRoot, target.revision, slot.branch)) {
    throw new Error(`Rebased task '${slot.branch}' does not descend from base branch '${target.branch}'`);
  }
  const { stdout: rebasedTip } = await runGit(slot.path, ["rev-parse", "HEAD"]);
  return rebasedTip;
}

async function abortFailedRebase(worktreePath, originalTip, baseBranch, trunk, rebaseError) {
  try {
    await runGit(worktreePath, ["rebase", "--abort"]);
  } catch (abortError) {
    throw new AggregateError(
      [rebaseError, abortError],
      `Task rebase failed and its automatic abort also failed; recover the preserved worktree at ${worktreePath}`,
    );
  }
  const { stdout: restoredTip } = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  if (restoredTip !== originalTip) {
    throw new Error(`Task rebase failed and abort did not restore the original tip at ${worktreePath}`);
  }
  const preservedBranch = baseBranch === trunk
    ? "synchronized trunk was preserved"
    : `synchronized base branch '${baseBranch}' was preserved`;
  throw new Error(`Task rebase encountered a conflict or other failure and was automatically aborted; the task tip was restored and ${preservedBranch}: ${rebaseError.message}`, { cause: rebaseError });
}
