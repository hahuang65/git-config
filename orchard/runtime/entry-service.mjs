import { findMainProjectDirectory } from "./git.mjs";
import { withProjectLock } from "./lock.mjs";
import { claimTaskOwner } from "./ownership.mjs";
import { findProjectRegistry, saveProjectState } from "./registry.mjs";

export async function enterTask({ cwd, home, intent, ownerPid = process.ppid, shared = false }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!projectRoot) throw new Error("orchard enter must run inside a Git repository");
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = registry.state.slots.find((candidate) => candidate.lifecycle === "task" && candidate.intent === intent);
    if (!slot) throw new Error(`No managed task worktree matches '${intent}'`);
    const owner = claimTaskOwner(slot, { pid: ownerPid, shared });
    await saveProjectState(registry);
    return createEntryOutcome(registry.state.project, slot, owner);
  });
}

export async function releaseTaskOwner({ cwd, home, intent, token }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  const located = projectRoot && await findProjectRegistry({ home, projectRoot });
  if (!located) return false;
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = registry.state.slots.find((candidate) => candidate.lifecycle === "task" && candidate.intent === intent);
    if (!slot) return false;
    const previousCount = (slot.owners ?? []).length;
    slot.owners = (slot.owners ?? []).filter((owner) => owner.token !== token);
    if (slot.owners.length === previousCount) return false;
    await saveProjectState(registry);
    return true;
  });
}

function createEntryOutcome(project, slot, owner) {
  return {
    project,
    worktree: { path: slot.path, intent: slot.intent, branch: slot.branch },
    owner,
    transition: { kind: "enter-worktree", operationId: owner.token, targetPath: slot.path },
  };
}
