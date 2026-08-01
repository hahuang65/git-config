import { createHash, randomUUID } from "node:crypto";

import { runGit } from "./git.mjs";

export async function captureConversionState(projectRoot) {
  const snapshot = await readStatus(projectRoot);
  if (!snapshot) return undefined;
  const marker = `treehouse-convert:${randomUUID()}`;
  await runGit(projectRoot, ["stash", "push", "--include-untracked", "--message", marker]);
  const { stdout: stashOid } = await runGit(projectRoot, ["rev-parse", "refs/stash"]);
  if (await readStatus(projectRoot)) throw new Error("Could not capture the complete working state for conversion");
  return {
    stashOid,
    marker,
    snapshot,
    snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
  };
}

export async function applyConversionState(worktreePath, captured) {
  if (!captured) return;
  await runGit(worktreePath, ["stash", "apply", "--index", captured.stashOid]);
  const restored = await readStatus(worktreePath);
  if (restored !== captured.snapshot) {
    throw new Error("Restored working state did not match the captured staged, unstaged, and untracked state");
  }
}

export async function dropConversionState(projectRoot, captured) {
  if (!captured) return;
  const { stdout } = await runGit(projectRoot, ["stash", "list", "--format=%H %gd"]);
  const entry = stdout.split("\n").find((line) => line.startsWith(`${captured.stashOid} `));
  if (!entry) throw new Error(`Recovery stash ${captured.stashOid} could not be found`);
  await runGit(projectRoot, ["stash", "drop", entry.slice(entry.indexOf(" ") + 1)]);
}

async function readStatus(worktreePath) {
  const { stdout } = await runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  return stdout;
}
