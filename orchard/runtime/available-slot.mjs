import { runGit } from "./git.mjs";

export async function moveAvailableSlot({ projectRoot, slot, worktreePath }) {
  const availablePath = slot.path;
  await runGit(projectRoot, ["worktree", "move", availablePath, worktreePath]);
  return availablePath;
}

export async function restoreAvailableSlot({ projectRoot, trunk, worktreePath, availablePath }) {
  try {
    await runGit(worktreePath, ["switch", "--detach", trunk]);
    await runGit(projectRoot, ["worktree", "move", worktreePath, availablePath]);
  } catch {
    // Git worktree metadata preserves the failed slot for conservative recovery.
  }
}
