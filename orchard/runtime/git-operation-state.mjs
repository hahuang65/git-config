import { access } from "node:fs/promises";

import { runGit } from "./git.mjs";

const OPERATION_MARKERS = Object.freeze([
  { operation: "merge", paths: ["MERGE_HEAD"] },
  { operation: "rebase", paths: ["rebase-merge", "rebase-apply"] },
  { operation: "cherry-pick", paths: ["CHERRY_PICK_HEAD"] },
  { operation: "revert", paths: ["REVERT_HEAD"] },
  { operation: "bisect", paths: ["BISECT_START"] },
]);

export async function assertNoInProgressGitOperation(worktreePath) {
  if (!await pathExists(worktreePath)) return;
  for (const { operation, paths } of OPERATION_MARKERS) {
    for (const marker of paths) {
      const { stdout: markerPath } = await runGit(worktreePath, ["rev-parse", "--git-path", marker]);
      if (await pathExists(markerPath)) {
        throw new Error(`Task worktree has an in-progress ${operation}`);
      }
    }
  }
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
