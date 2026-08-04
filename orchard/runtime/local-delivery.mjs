import { randomUUID } from "node:crypto";

import { findMainProjectDirectory, findRepositoryRoot, runGit } from "./git.mjs";
import { rebaseTaskOntoTrunk, resolveTaskSlot, validateTaskWorkspace } from "./integration.mjs";
import { withProjectLock } from "./lock.mjs";
import { refreshTaskOwners } from "./ownership.mjs";
import { pathsReferToSameLocation } from "./paths.mjs";
import { recycleSlot, validateRecyclable } from "./recycle-service.mjs";
import { findProjectRegistry, saveProjectState } from "./registry.mjs";
import { synchronizeTrunk } from "./synchronize.mjs";

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
    await validateLocalDelivery(registry, slot);
    await rebaseTaskOntoTrunk(registry, slot);
    const integrated = await fastForwardTask(registry, slot, { keep });
    if (!finalizeImmediately || keep) return integrated;
    return finalizeIntegratedSlot(registry, slot, cwd, integrated);
  });
}

async function validateLocalDelivery(registry, slot) {
  const { root: projectRoot, trunk } = registry.state.project;
  await validateTaskWorkspace(registry, slot);
  await synchronizeTrunk(projectRoot, trunk);
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
