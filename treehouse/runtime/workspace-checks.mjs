import { runGit } from "./git.mjs";

export async function assertCleanWorktree(worktreePath, label = "worktree") {
  const { stdout } = await runGit(worktreePath, ["status", "--porcelain", "--untracked-files=normal"]);
  if (stdout) throw new Error(`The ${label} must be clean`);
}

export async function readCurrentBranch(worktreePath) {
  const { stdout } = await runGit(worktreePath, ["branch", "--show-current"]);
  if (!stdout) throw new Error("A named branch must be checked out");
  return stdout;
}
