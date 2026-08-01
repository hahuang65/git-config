import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { findMainProjectDirectory, findRepositoryRoot, runGit } from "./git.mjs";
import { proveLanding } from "./landing.mjs";
import { withProjectLock } from "./lock.mjs";
import { refreshTaskOwners } from "./ownership.mjs";
import { findProjectRegistry, saveProjectState } from "./registry.mjs";
import { assertCleanWorktree } from "./workspace-checks.mjs";

export async function recycleTask({ cwd, home, intent, keepBranch = false }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!projectRoot) throw new Error("treehouse recycle must run inside a Git repository");
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Treehouse project group");
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = await resolveTaskSlot(registry, cwd, intent);
    const proof = await validateRecyclable(registry, slot, cwd);
    return recycleSlot(registry, slot, { keepBranch, proof });
  });
}

async function resolveTaskSlot(registry, cwd, intent) {
  if (intent) {
    const slot = registry.state.slots.find((candidate) => candidate.lifecycle === "task" && candidate.intent === intent);
    if (!slot) throw new Error(`No managed task worktree matches '${intent}'`);
    return slot;
  }
  const checkoutRoot = await findRepositoryRoot(cwd);
  const slot = registry.state.slots.find((candidate) => candidate.lifecycle === "task" && candidate.path === checkoutRoot);
  if (!slot) throw new Error("Specify a managed task intent to recycle");
  return slot;
}

async function validateRecyclable(registry, slot, cwd) {
  if (slot.recovery) throw new Error(`Task worktree '${slot.intent}' has unresolved recovery state`);
  if (refreshTaskOwners(slot).length > 0) throw new Error(`Task worktree '${slot.intent}' is occupied`);
  const callerRoot = await findRepositoryRoot(cwd);
  if (callerRoot === await realpath(slot.path)) throw new Error("Cannot recycle the caller's current worktree");
  await assertCleanWorktree(slot.path, "task worktree");
  const { stdout: featureTip } = await runGit(registry.state.project.root, ["rev-parse", slot.branch]);
  const proof = await proveLanding({
    projectRoot: registry.state.project.root,
    featureBranch: slot.branch,
    featureTip,
    trunk: registry.state.project.trunk,
  });
  if (proof.status !== "landed") {
    throw new Error(`Task branch '${slot.branch}' is not proven landed on trunk (${proof.evidence})`);
  }
  return proof;
}

async function recycleSlot(registry, slot, { keepBranch, proof }) {
  const branch = slot.branch;
  const cleanupOperationId = slot.pendingCleanup?.operationId;
  const poolDirectory = path.join(registry.directory, ".pool");
  const availablePath = path.join(poolDirectory, slot.id);
  await mkdir(poolDirectory, { recursive: true });
  await runGit(slot.path, ["switch", "--detach", registry.state.project.trunk]);
  await runGit(registry.state.project.root, ["worktree", "move", slot.path, availablePath]);
  Object.assign(slot, {
    lifecycle: "available",
    path: availablePath,
    intent: null,
    branch: null,
    owners: [],
    availableAt: new Date().toISOString(),
  });
  delete slot.pendingCleanup;
  if (cleanupOperationId) slot.completedCleanupOperationId = cleanupOperationId;
  await saveProjectState(registry);
  if (!keepBranch) {
    const deleteOption = proof.evidence === "ancestry" ? "-d" : "-D";
    await runGit(registry.state.project.root, ["branch", deleteOption, branch]);
  }
  return {
    project: registry.state.project,
    slot: { id: slot.id, lifecycle: slot.lifecycle, path: slot.path },
    removedBranch: keepBranch ? null : branch,
  };
}
