import { findMainProjectDirectory, findRepositoryRoot } from "./git.mjs";
import { rebaseTaskOntoTrunk, resolveTaskSlot, validateTaskWorkspace } from "./integration.mjs";
import { finalizeRecoveredRebase, rebaseTaskWithConflictRecovery } from "./rebase-conflict-recovery.mjs";
import { withProjectLock } from "./lock.mjs";
import { refreshTaskOwners } from "./ownership.mjs";
import { pathsReferToSameLocation } from "./paths.mjs";
import { findProjectRegistry } from "./registry.mjs";
import { synchronizeTrunk } from "./synchronize.mjs";

export async function rebaseTask({ cwd, home, intent, preserveConflicts = false }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!projectRoot) throw new Error("orchard rebase must run inside a Git repository");
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  const callerRoot = await findRepositoryRoot(cwd);
  const invokedFromMain = callerRoot && await pathsReferToSameLocation(callerRoot, projectRoot);
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = await resolveTaskSlot(registry, cwd, intent);
    if (invokedFromMain && refreshTaskOwners(slot).length > 0) {
      throw new Error(`Task worktree '${slot.intent}' is occupied`);
    }
    await validateTaskWorkspace(registry, slot);
    await synchronizeTrunk(projectRoot, registry.state.project.trunk);
    const rebase = preserveConflicts
      ? await rebaseTaskWithConflictRecovery(registry, slot)
      : { status: "rebased", tip: await rebaseTaskOntoTrunk(registry, slot) };
    return {
      project: registry.state.project,
      worktree: { path: slot.path, intent: slot.intent, branch: slot.branch },
      rebase,
      transition: { kind: "none", targetPath: slot.path },
    };
  });
}

export async function finalizeRebaseOperation({ cwd, home, operationId }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!projectRoot) throw new Error("orchard rebase must run inside a Git repository");
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    return finalizeRecoveredRebase(registry, operationId);
  });
}
