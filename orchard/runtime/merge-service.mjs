import { randomUUID } from "node:crypto";

import { findMainProjectDirectory, findRepositoryRoot, runGit } from "./git.mjs";
import { isTipAncestorOfTrunk } from "./landing.mjs";
import { withProjectLock } from "./lock.mjs";
import { pathsReferToSameLocation } from "./paths.mjs";
import { recycleTask } from "./recycle-service.mjs";
import { findProjectRegistry, saveProjectState } from "./registry.mjs";
import { assertCleanWorktree, readCurrentBranch } from "./workspace-checks.mjs";

export async function mergeTask({ cwd, home, intent, keep = false }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!projectRoot) throw new Error("orchard merge must run inside a Git repository");
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = await resolveTaskSlot(registry, cwd, intent);
    await validateMerge(registry, slot);
    await rebaseTaskOntoTrunk(registry, slot);
    return fastForwardTask(registry, slot, { keep });
  });
}

async function resolveTaskSlot(registry, cwd, intent) {
  if (intent) {
    const slot = registry.state.slots.find((candidate) => candidate.lifecycle === "task" && candidate.intent === intent);
    if (!slot) throw new Error(`No managed task worktree matches '${intent}'`);
    return slot;
  }
  const checkoutRoot = await findRepositoryRoot(cwd);
  let slot;
  for (const candidate of registry.state.slots.filter((entry) => entry.lifecycle === "task")) {
    if (checkoutRoot && await pathsReferToSameLocation(candidate.path, checkoutRoot)) {
      slot = candidate;
      break;
    }
  }
  if (!slot) throw new Error("orchard merge requires a managed task worktree or explicit intent");
  return slot;
}

async function validateMerge(registry, slot) {
  const { root: projectRoot, trunk } = registry.state.project;
  if (slot.recovery) throw new Error(`Task worktree '${slot.intent}' has unresolved recovery state`);
  await assertCleanWorktree(slot.path, "task worktree");
  await assertCleanWorktree(projectRoot, "main project directory");
  const branch = await readCurrentBranch(projectRoot);
  if (branch !== trunk) throw new Error(`The main project directory must have trunk '${trunk}' checked out`);
  const taskBranch = await readCurrentBranch(slot.path);
  if (taskBranch !== slot.branch) throw new Error(`Task worktree must have branch '${slot.branch}' checked out`);
  await assertTrunkMatchesUpstream(projectRoot, trunk);
}

async function rebaseTaskOntoTrunk(registry, slot) {
  const { root: projectRoot, trunk } = registry.state.project;
  const { stdout: originalTip } = await runGit(slot.path, ["rev-parse", "HEAD"]);
  try {
    await runGit(slot.path, ["rebase", trunk]);
  } catch (error) {
    try {
      await runGit(slot.path, ["rebase", "--abort"]);
    } catch (abortError) {
      throw new AggregateError(
        [error, abortError],
        `Task rebase failed and its automatic abort also failed; recover the preserved worktree at ${slot.path}`,
      );
    }
    const { stdout: restoredTip } = await runGit(slot.path, ["rev-parse", "HEAD"]);
    if (restoredTip !== originalTip) {
      throw new Error(`Task rebase failed and abort did not restore the original tip at ${slot.path}`);
    }
    throw new Error(`Task rebase encountered a conflict or other failure and was automatically aborted; trunk and task are unchanged`, { cause: error });
  }
  if (!await isTipAncestorOfTrunk(projectRoot, trunk, slot.branch)) {
    throw new Error(`Rebased task '${slot.branch}' cannot fast-forward trunk '${trunk}'`);
  }
}

async function assertTrunkMatchesUpstream(projectRoot, trunk) {
  await runGit(projectRoot, ["fetch", "--all", "--prune"]);
  let upstream;
  try {
    ({ stdout: upstream } = await runGit(projectRoot, ["rev-parse", "--abbrev-ref", `${trunk}@{upstream}`]));
  } catch (error) {
    if (error?.code === 128) return;
    throw error;
  }
  const { stdout: trunkTip } = await runGit(projectRoot, ["rev-parse", trunk]);
  const { stdout: upstreamTip } = await runGit(projectRoot, ["rev-parse", upstream]);
  if (trunkTip !== upstreamTip) throw new Error(`Trunk '${trunk}' is not synchronized with '${upstream}'`);
}

export async function finalizeMergedTask({ cwd, home, operationId }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  const checkoutRoot = await findRepositoryRoot(cwd);
  if (!projectRoot || !checkoutRoot || !await pathsReferToSameLocation(projectRoot, checkoutRoot)) {
    throw new Error("Merge cleanup requires the caller to return to the main project directory");
  }
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  const cleanup = await withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const pending = registry.state.slots.find((candidate) => candidate.pendingCleanup?.operationId === operationId);
    if (pending) return { intent: pending.intent };
    const completed = registry.state.slots.find((candidate) => candidate.completedCleanupOperationId === operationId);
    if (completed) return { project: registry.state.project, slot: completed };
    throw new Error("No pending merge cleanup matches that operation");
  });
  if (cleanup.slot) {
    return {
      project: cleanup.project,
      cleanup: { status: "completed", operationId },
      slot: { id: cleanup.slot.id, lifecycle: cleanup.slot.lifecycle, path: cleanup.slot.path },
    };
  }
  const recycled = await recycleTask({ cwd: projectRoot, home, intent: cleanup.intent });
  return { project: recycled.project, cleanup: { status: "completed", operationId }, slot: recycled.slot };
}

async function fastForwardTask(registry, slot, { keep }) {
  const { root: projectRoot, trunk } = registry.state.project;
  const { stdout: featureTip } = await runGit(projectRoot, ["rev-parse", slot.branch]);
  await runGit(projectRoot, ["merge", "--ff-only", slot.branch]);
  const { stdout: trunkTip } = await runGit(projectRoot, ["rev-parse", trunk]);
  if (trunkTip !== featureTip) throw new Error("Fast-forward did not leave trunk at the exact feature tip");
  const operationId = keep ? undefined : randomUUID();
  if (operationId) {
    slot.pendingCleanup = {
      operationId,
      integratedTip: featureTip,
      requestedAt: new Date().toISOString(),
    };
    await saveProjectState(registry);
  }
  return {
    project: registry.state.project,
    worktree: { path: slot.path, intent: slot.intent, branch: slot.branch },
    integration: { status: "fast-forwarded", strategy: "rebase", tip: featureTip },
    cleanup: { requested: !keep },
    transition: keep
      ? { kind: "none", targetPath: slot.path }
      : { kind: "return-main", operationId, targetPath: projectRoot },
  };
}
