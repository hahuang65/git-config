import path from "node:path";

import { runGit } from "./git.mjs";
import { isTipAncestorOfTrunk } from "./landing.mjs";
import { synchronizeTrunk } from "./synchronize.mjs";
import { assertCleanWorktree, readCurrentBranch } from "./workspace-checks.mjs";

export async function rebaseOrdinaryBranch(inspection) {
  const { projectRoot, project, slot } = inspection;
  await validateOrdinaryBranch(projectRoot, project.trunk, slot.branch);
  await switchToTrunkAndSynchronize(projectRoot, project.trunk, slot.branch);
  const originalTip = await readTip(projectRoot, "HEAD");
  try {
    await runGit(projectRoot, ["rebase", project.trunk]);
  } catch (error) {
    await abortFailedRebase(projectRoot, originalTip, error);
  }
  if (!await isTipAncestorOfTrunk(projectRoot, project.trunk, slot.branch)) {
    throw new Error(`Rebased branch '${slot.branch}' does not descend from trunk '${project.trunk}'`);
  }
  const tip = await readTip(projectRoot, "HEAD");
  return {
    project,
    worktree: ordinaryBranchTarget(projectRoot, slot.branch),
    rebase: { status: "rebased", tip },
    transition: { kind: "none", targetPath: projectRoot },
  };
}

export async function integrateOrdinaryBranch({ inspection, keep = false }) {
  const rebased = await rebaseOrdinaryBranch(inspection);
  const { projectRoot, project, slot } = inspection;
  try {
    await runGit(projectRoot, ["switch", project.trunk]);
    await runGit(projectRoot, ["merge", "--ff-only", slot.branch]);
    const trunkTip = await readTip(projectRoot, project.trunk);
    if (trunkTip !== rebased.rebase.tip) {
      throw new Error("Fast-forward did not leave trunk at the exact feature tip");
    }
  } catch (error) {
    await restoreFeatureCheckout(projectRoot, slot.branch, error);
  }
  if (!keep) await runGit(projectRoot, ["branch", "--delete", slot.branch]);
  return {
    project,
    worktree: ordinaryBranchTarget(projectRoot, slot.branch),
    integration: { status: "fast-forwarded", strategy: "rebase", tip: rebased.rebase.tip },
    cleanup: { status: keep ? "kept" : "completed", requested: !keep },
    transition: { kind: "none", targetPath: projectRoot },
  };
}

export function createOrdinaryBranchProject(projectRoot, trunk) {
  return { root: projectRoot, name: path.basename(projectRoot), trunk };
}

export function ordinaryBranchTarget(projectRoot, branch) {
  return { path: projectRoot, intent: branch, branch, kind: "ordinary-branch" };
}

async function validateOrdinaryBranch(projectRoot, trunk, branch) {
  await assertCleanWorktree(projectRoot, "working branch");
  const currentBranch = await readCurrentBranch(projectRoot);
  if (currentBranch !== branch) throw new Error(`Working branch changed from '${branch}' to '${currentBranch}'`);
  if (branch === trunk) throw new Error(`Delivery requires a feature branch rather than trunk '${trunk}'`);
}

async function switchToTrunkAndSynchronize(projectRoot, trunk, branch) {
  await runGit(projectRoot, ["switch", trunk]);
  try {
    await synchronizeTrunk(projectRoot, trunk);
    await runGit(projectRoot, ["switch", branch]);
  } catch (error) {
    await restoreFeatureCheckout(projectRoot, branch, error);
  }
}

async function restoreFeatureCheckout(projectRoot, branch, originalError) {
  try {
    if (await readCurrentBranch(projectRoot) !== branch) {
      await runGit(projectRoot, ["switch", branch]);
    }
  } catch (restoreError) {
    throw new AggregateError(
      [originalError, restoreError],
      `Delivery failed and Orchard could not restore working branch '${branch}'`,
    );
  }
  throw originalError;
}

async function abortFailedRebase(projectRoot, originalTip, rebaseError) {
  try {
    await runGit(projectRoot, ["rebase", "--abort"]);
  } catch (abortError) {
    throw new AggregateError(
      [rebaseError, abortError],
      `Branch rebase failed and its automatic abort also failed at ${projectRoot}`,
    );
  }
  const restoredTip = await readTip(projectRoot, "HEAD");
  if (restoredTip !== originalTip) {
    throw new Error(`Branch rebase failed and abort did not restore the original tip at ${projectRoot}`);
  }
  throw new Error(
    `Branch rebase encountered a conflict or other failure and was automatically aborted: ${rebaseError.message}`,
    { cause: rebaseError },
  );
}

async function readTip(projectRoot, reference) {
  const { stdout } = await runGit(projectRoot, ["rev-parse", reference]);
  return stdout;
}
