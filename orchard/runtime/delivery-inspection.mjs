import { findMainProjectDirectory, findRepositoryRoot, runGit } from "./git.mjs";
import { resolveTaskSlot } from "./integration.mjs";
import { withProjectLock } from "./lock.mjs";
import { refreshTaskOwners } from "./ownership.mjs";
import { findProjectRegistry } from "./registry.mjs";

export async function inspectDeliveryTask({ cwd, home, intent }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!projectRoot) throw new Error("orchard deliver must run inside a Git repository");
  const registry = await findProjectRegistry({ home, projectRoot });
  if (!registry) throw new Error("This repository has no Orchard project group");
  const slot = await resolveTaskSlot(registry, cwd, intent);
  const [{ stdout: status }, callerRoot] = await Promise.all([
    runGit(slot.path, ["status", "--short"]),
    findRepositoryRoot(cwd),
  ]);
  return { projectRoot, callerRoot, registry, slot, status };
}

export async function assertNamedDeliveryUnoccupied({ home, projectRoot, intent }) {
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  await withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = await resolveTaskSlot(registry, projectRoot, intent);
    if (refreshTaskOwners(slot).length > 0) throw new Error(`Task worktree '${slot.intent}' is occupied`);
  });
}

export function createNeedsCommitOutcome(registry, slot, status) {
  return {
    project: registry.state.project,
    worktree: { path: slot.path, intent: slot.intent, branch: slot.branch },
    commit: { status },
    delivery: { status: "needs-commit" },
    transition: { kind: "none", targetPath: slot.path },
  };
}
