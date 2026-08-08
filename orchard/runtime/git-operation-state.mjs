import { access, readFile } from "node:fs/promises";

import { runGit } from "./git.mjs";

const OPERATION_MARKERS = Object.freeze([
  { operation: "merge", paths: ["MERGE_HEAD"] },
  { operation: "rebase", paths: ["rebase-merge", "rebase-apply"] },
  { operation: "cherry-pick", paths: ["CHERRY_PICK_HEAD"] },
  { operation: "revert", paths: ["REVERT_HEAD"] },
  { operation: "bisect", paths: ["BISECT_START"] },
]);

export async function assertNoInProgressGitOperation(worktreePath) {
  const operation = await readInProgressGitOperation(worktreePath);
  if (operation) throw new Error(`Task worktree has an in-progress ${operation}`);
}

export async function readInProgressGitOperation(worktreePath) {
  if (!await pathExists(worktreePath)) return undefined;
  for (const { operation, paths } of OPERATION_MARKERS) {
    for (const marker of paths) {
      const { stdout: markerPath } = await runGit(worktreePath, ["rev-parse", "--git-path", marker]);
      if (await pathExists(markerPath)) return operation;
    }
  }
  return undefined;
}

export async function isHeadDetached(worktreePath) {
  try {
    await runGit(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
    return false;
  } catch (error) {
    if (error?.code === 1) return true;
    throw error;
  }
}

export async function readRebaseOperationMetadata(worktreePath) {
  if (await readInProgressGitOperation(worktreePath) !== "rebase") return undefined;
  for (const directory of ["rebase-merge", "rebase-apply"]) {
    const [headName, onto, originalTip] = await Promise.all([
      readGitPathFile(worktreePath, `${directory}/head-name`),
      readGitPathFile(worktreePath, `${directory}/onto`),
      readGitPathFile(worktreePath, `${directory}/orig-head`),
    ]);
    if (headName && onto && originalTip) return { headName, onto, originalTip };
  }
  return undefined;
}

async function readGitPathFile(worktreePath, relativePath) {
  const { stdout: filePath } = await runGit(worktreePath, ["rev-parse", "--git-path", relativePath]);
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
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
