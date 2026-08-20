import { randomUUID } from "node:crypto";

import { findMainProjectDirectory, findRepositoryRoot, runGit } from "./git.mjs";
import { rebaseTaskOntoTarget, resolveTaskSlot, validateTaskWorkspace } from "./integration.mjs";
import { withProjectLock } from "./lock.mjs";
import { refreshTaskOwners } from "./ownership.mjs";
import { pathsReferToSameLocation } from "./paths.mjs";
import { recycleSlot, validateRecyclable } from "./recycle-service.mjs";
import { findProjectRegistry, saveProjectState } from "./registry.mjs";
import { prepareTaskBase } from "./task-base.mjs";
import { readWorktreeMetadata } from "./worktree-metadata.mjs";

export async function integrateTaskLocally({
  cwd,
  home,
  intent,
  keep = false,
  invokedFromMain = false,
  finalizeImmediately = false,
}) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!projectRoot) throw new Error("Local delivery must run inside a Git repository");
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = await resolveTaskSlot(registry, cwd, intent);
    if (invokedFromMain && refreshTaskOwners(slot).length > 0) {
      throw new Error(`Task worktree '${slot.intent}' is occupied`);
    }
    const target = await validateLocalDelivery(registry, slot);
    await rebaseTaskOntoTarget(registry, slot, target);
    const integrated = await fastForwardTask(registry, slot, { keep, target });
    if (!finalizeImmediately || keep) return integrated;
    return finalizeIntegratedSlot(registry, slot, cwd, integrated);
  });
}

async function validateLocalDelivery(registry, slot) {
  await validateTaskWorkspace(registry, slot);
  return prepareTaskBase(registry, slot);
}

export async function finalizeLocalDelivery({ cwd, home, operationId, intent }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  const checkoutRoot = await findRepositoryRoot(cwd);
  if (!projectRoot || !checkoutRoot || !await pathsReferToSameLocation(projectRoot, checkoutRoot)) {
    throw new Error("Delivery cleanup requires the caller to return to the main project directory");
  }
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const cleanup = resolveCleanup(registry, { operationId, intent });
    if (cleanup.completed) {
      return createCompletedCleanup(registry.state.project, cleanup.slot, cleanup.operationId);
    }
    const proof = await validateRecyclable(registry, cleanup.slot, cwd);
    const recycled = await recycleSlot(registry, cleanup.slot, { keepBranch: false, proof });
    return {
      project: recycled.project,
      cleanup: { status: "completed", operationId: cleanup.operationId },
      slot: recycled.slot,
    };
  });
}

function resolveCleanup(registry, { operationId, intent }) {
  const pending = registry.state.slots.find((candidate) => {
    if (!candidate.pendingCleanup) return false;
    return operationId
      ? candidate.pendingCleanup.operationId === operationId
      : candidate.lifecycle === "task" && candidate.intent === intent;
  });
  if (pending) {
    return { slot: pending, operationId: pending.pendingCleanup.operationId, completed: false };
  }
  if (operationId) {
    const completed = registry.state.slots.find((candidate) => candidate.completedCleanupOperationId === operationId);
    if (completed) return { slot: completed, operationId, completed: true };
  }
  const selector = intent ? `worktree '${intent}'` : "operation";
  throw new Error(`No pending delivery cleanup matches ${selector}`);
}

async function finalizeIntegratedSlot(registry, slot, cwd, integrated) {
  const proof = await validateRecyclable(registry, slot, cwd);
  const recycled = await recycleSlot(registry, slot, { keepBranch: false, proof });
  return {
    ...integrated,
    cleanup: { status: "completed", operationId: integrated.transition.operationId },
    slot: recycled.slot,
    transition: { kind: "none", targetPath: registry.state.project.root },
  };
}

function createCompletedCleanup(project, slot, operationId) {
  return {
    project,
    cleanup: { status: "completed", operationId },
    slot: { id: slot.id, lifecycle: slot.lifecycle, path: slot.path },
  };
}

async function fastForwardUnattachedBase(projectRoot, baseBranch, featureTip) {
  const worktrees = await readWorktreeMetadata(projectRoot);
  if (worktrees.some((worktree) => worktree.branch === baseBranch)) {
    throw new Error(`Base branch '${baseBranch}' is checked out in another worktree`);
  }
  const baseReference = `refs/heads/${baseBranch}`;
  const { stdout: originalBaseTip } = await runGit(projectRoot, ["rev-parse", baseReference]);
  try {
    await runGit(projectRoot, ["merge-base", "--is-ancestor", originalBaseTip, featureTip]);
  } catch (error) {
    if (error?.code === 1) {
      throw new Error(`Local base branch '${baseBranch}' has diverged from the rebased task`);
    }
    throw error;
  }
  await runGit(projectRoot, ["update-ref", baseReference, featureTip, originalBaseTip]);
}

async function fastForwardTask(registry, slot, { keep, target }) {
  const { root: projectRoot, trunk } = registry.state.project;
  const { stdout: featureTip } = await runGit(projectRoot, ["rev-parse", slot.branch]);
  if (target.branch === trunk) {
    await runGit(projectRoot, ["merge", "--ff-only", slot.branch]);
  } else {
    await fastForwardUnattachedBase(projectRoot, target.branch, featureTip);
  }
  const { stdout: baseTip } = await runGit(projectRoot, ["rev-parse", target.branch]);
  if (baseTip !== featureTip) {
    throw new Error(`Fast-forward did not leave base branch '${target.branch}' at the exact feature tip`);
  }
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
    integration: {
      status: "fast-forwarded",
      strategy: "rebase",
      baseBranch: target.branch,
      tip: featureTip,
    },
    cleanup: { requested: !keep },
    transition: keep
      ? { kind: "none", targetPath: slot.path }
      : { kind: "return-main", operationId, targetPath: projectRoot },
  };
}
