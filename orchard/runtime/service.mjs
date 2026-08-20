import path from "node:path";

import { attachTaskBranch, createBranchBoundWorktree } from "./branch.mjs";
import { readOrchardCapacity } from "./capacity.mjs";
import { findRemoteTrunk, findRepositoryRoot, runGit } from "./git.mjs";
import { normalizeIntent } from "./intent.mjs";
import { withProjectLock } from "./lock.mjs";
import { openProjectRegistry, saveProjectState } from "./registry.mjs";
import { synchronizeTrunk } from "./synchronize.mjs";
import { createTaskOutcome, createTaskSlot } from "./task.mjs";
import { assertCleanWorktree, readCurrentBranch } from "./workspace-checks.mjs";

export async function acquireTask({ cwd, home, requestedIntent, offline = false }) {
  const capacity = readOrchardCapacity();
  const projectRoot = await findRepositoryRoot(cwd);
  if (!projectRoot) throw new Error("orchard new must run inside a Git repository");
  const checkedOutBranch = await readCurrentBranch(projectRoot);
  const trunk = offline ? checkedOutBranch : (await findRemoteTrunk(projectRoot) ?? checkedOutBranch);
  if (checkedOutBranch !== trunk) {
    throw new Error(`The main project directory must have trunk '${trunk}' checked out`);
  }
  await assertCleanWorktree(projectRoot, "main project directory");
  if (!offline) await synchronizeTrunk(projectRoot, trunk);
  const intent = normalizeIntent(requestedIntent);
  const discovered = await openProjectRegistry({ home, projectRoot, trunk });
  return withProjectLock(discovered.directory, async () => {
    const registry = await openProjectRegistry({ home, projectRoot, trunk });
    return acquireInRegistry({ registry, projectRoot, checkedOutBranch, intent, capacity });
  });
}

async function acquireInRegistry({ registry, projectRoot, checkedOutBranch, intent, capacity }) {
  const trunk = registry.state.project.trunk;
  if (checkedOutBranch !== trunk) {
    throw new Error(`The main project directory must have trunk '${trunk}' checked out`);
  }
  const available = registry.state.slots.find((slot) => slot.lifecycle === "available");
  if (available) return reuseAvailableSlot({ registry, slot: available, projectRoot, trunk, intent });
  if (registry.state.slots.length >= capacity) {
    throw new Error(`Orchard capacity of ${capacity} reached for ${registry.state.project.name}`);
  }
  const worktreePath = path.join(registry.directory, intent);
  const branch = await createBranchBoundWorktree({ projectRoot, trunk, intent, worktreePath });
  const slot = createTaskSlot({ worktreePath, intent, branch, baseBranch: trunk });
  registry.state.slots.push(slot);
  await saveProjectState(registry);
  return createTaskOutcome(registry.state.project, slot);
}

async function reuseAvailableSlot({ registry, slot, projectRoot, trunk, intent }) {
  const availablePath = slot.path;
  const worktreePath = path.join(registry.directory, intent);
  await runGit(projectRoot, ["worktree", "move", availablePath, worktreePath]);
  let branch;
  try {
    branch = await attachTaskBranch({ projectRoot, trunk, intent, worktreePath });
  } catch (error) {
    await restoreAvailableSlot({ projectRoot, trunk, worktreePath, availablePath });
    throw error;
  }
  Object.assign(slot, {
    lifecycle: "task",
    path: worktreePath,
    intent,
    branch,
    baseBranch: trunk,
    owners: [],
    assignedAt: new Date().toISOString(),
  });
  delete slot.availableAt;
  await saveProjectState(registry);
  return createTaskOutcome(registry.state.project, slot);
}

async function restoreAvailableSlot({ projectRoot, trunk, worktreePath, availablePath }) {
  try {
    await runGit(worktreePath, ["switch", "--detach", trunk]);
    await runGit(projectRoot, ["worktree", "move", worktreePath, availablePath]);
  } catch {
    // Git worktree metadata preserves the failed slot for conservative recovery.
  }
}
