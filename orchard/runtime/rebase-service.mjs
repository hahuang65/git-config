import { findMainProjectDirectory } from "./git.mjs";
import { rebaseTaskOntoTrunk, resolveTaskSlot, validateTaskWorkspace } from "./integration.mjs";
import { withProjectLock } from "./lock.mjs";
import { findProjectRegistry } from "./registry.mjs";
import { synchronizeTrunk } from "./synchronize.mjs";

export async function rebaseTask({ cwd, home, intent }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!projectRoot) throw new Error("orchard rebase must run inside a Git repository");
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = await resolveTaskSlot(registry, cwd, intent);
    await validateTaskWorkspace(registry, slot);
    await synchronizeTrunk(projectRoot, registry.state.project.trunk);
    const tip = await rebaseTaskOntoTrunk(registry, slot);
    return {
      project: registry.state.project,
      worktree: { path: slot.path, intent: slot.intent, branch: slot.branch },
      rebase: { status: "rebased", tip },
      transition: { kind: "none", targetPath: slot.path },
    };
  });
}
