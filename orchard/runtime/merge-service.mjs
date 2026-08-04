import { randomUUID } from "node:crypto";

import { findMainProjectDirectory, findRepositoryRoot, runGit } from "./git.mjs";
import { rebaseTaskOntoTrunk, resolveTaskSlot, validateTaskWorkspace } from "./integration.mjs";
import { withProjectLock } from "./lock.mjs";
import { pathsReferToSameLocation } from "./paths.mjs";
import { recycleTask } from "./recycle-service.mjs";
import { findProjectRegistry, saveProjectState } from "./registry.mjs";
import { synchronizeTrunk } from "./synchronize.mjs";

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

async function validateMerge(registry, slot) {
  const { root: projectRoot, trunk } = registry.state.project;
  await validateTaskWorkspace(registry, slot);
  await synchronizeTrunk(projectRoot, trunk);
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
