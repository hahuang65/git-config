import path from "node:path";

import { moveAvailableSlot, restoreAvailableSlot } from "./available-slot.mjs";
import { readOrchardCapacity } from "./capacity.mjs";
import { applyConversionState, captureConversionState, dropConversionState } from "./conversion-state.mjs";
import { findMainProjectDirectory, findRemoteTrunk, findRepositoryRoot, runGit } from "./git.mjs";
import { normalizeIntent } from "./intent.mjs";
import { withProjectLock } from "./lock.mjs";
import { findProjectRegistry, openProjectRegistry, saveProjectState } from "./registry.mjs";
import { assignTaskSlot, createTaskOutcome, createTaskSlot } from "./task.mjs";
import { inferTaskBaseBranch } from "./task-base.mjs";
import { readCurrentBranch } from "./workspace-checks.mjs";

export async function convertTaskBranch({ cwd, home, requestedIntent }) {
  const capacity = readOrchardCapacity();
  const checkoutRoot = await findRepositoryRoot(cwd);
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!checkoutRoot || !projectRoot) throw new Error("orchard convert must run inside a Git repository");
  if (checkoutRoot !== projectRoot) throw new Error("orchard convert must run from the main project directory");
  const branch = await readCurrentBranch(projectRoot);
  const existing = await findProjectRegistry({ home, projectRoot });
  const trunk = existing?.state.project.trunk ?? await findRemoteTrunk(projectRoot);
  if (!trunk) throw new Error("Cannot determine trunk from Orchard state or remote metadata");
  if (branch === trunk) throw new Error(`Cannot convert trunk '${trunk}'`);
  const intent = normalizeIntent(requestedIntent ?? branch);
  const located = existing ?? await openProjectRegistry({ home, projectRoot, trunk });
  return withProjectLock(located.directory, () => convertUnderLock({ home, projectRoot, trunk, branch, intent, capacity }));
}

async function convertUnderLock({ home, projectRoot, trunk, branch, intent, capacity }) {
  const registry = await openProjectRegistry({ home, projectRoot, trunk });
  const availableSlot = registry.state.slots.find((slot) => slot.lifecycle === "available");
  if (!availableSlot && registry.state.slots.length >= capacity) {
    throw new Error(`Orchard capacity of ${capacity} reached for ${registry.state.project.name}`);
  }
  if (await readCurrentBranch(projectRoot) !== branch) throw new Error("The task branch changed during conversion");
  const baseBranch = await inferTaskBaseBranch({ projectRoot, taskBranch: branch, trunk });
  const captured = await captureConversionState(projectRoot);
  const worktreePath = path.join(registry.directory, intent);
  await runGit(projectRoot, ["switch", trunk]);
  try {
    await createConversionWorktree({ availableSlot, projectRoot, trunk, branch, worktreePath });
  } catch (error) {
    await recoverMainCheckout(projectRoot, branch, captured);
    throw new Error(`Conversion failed; branch '${branch}' remains recoverable and target path was '${worktreePath}': ${error.message}`);
  }
  return finishConversion({ registry, availableSlot, projectRoot, worktreePath, intent, branch, baseBranch, captured });
}

async function createConversionWorktree({ availableSlot, projectRoot, trunk, branch, worktreePath }) {
  if (!availableSlot) {
    await runGit(projectRoot, ["worktree", "add", worktreePath, branch]);
    return;
  }
  const availablePath = await moveAvailableSlot({ projectRoot, slot: availableSlot, worktreePath });
  try {
    await runGit(worktreePath, ["switch", branch]);
  } catch (error) {
    await restoreAvailableSlot({ projectRoot, trunk, worktreePath, availablePath });
    throw error;
  }
}

async function finishConversion({ registry, availableSlot, projectRoot, worktreePath, intent, branch, baseBranch, captured }) {
  const slot = availableSlot
    ? assignTaskSlot(availableSlot, { worktreePath, intent, branch, baseBranch })
    : createTaskSlot({ worktreePath, intent, branch, baseBranch });
  if (captured) slot.recovery = createRecoveryRecord(captured);
  if (!availableSlot) registry.state.slots.push(slot);
  await saveProjectState(registry);
  try {
    await applyConversionState(worktreePath, captured);
  } catch (error) {
    throw new Error(`Conversion needs recovery at '${worktreePath}'; stash ${captured.stashOid} was preserved: ${error.message}`);
  }
  delete slot.recovery;
  await saveProjectState(registry);
  await dropConversionState(projectRoot, captured);
  return createTaskOutcome(registry.state.project, slot);
}

async function recoverMainCheckout(projectRoot, branch, captured) {
  try {
    await runGit(projectRoot, ["switch", branch]);
    await applyConversionState(projectRoot, captured);
    await dropConversionState(projectRoot, captured);
  } catch {
    // The branch, stash, and Git worktree metadata remain available for manual recovery.
  }
}

function createRecoveryRecord(captured) {
  return {
    kind: "conversion",
    status: "restoring",
    stashOid: captured.stashOid,
    snapshotHash: captured.snapshotHash,
  };
}
