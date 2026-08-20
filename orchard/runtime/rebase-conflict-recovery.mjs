import { randomUUID } from "node:crypto";

import { proveBranchBinding } from "./branch-binding-verifier.mjs";
import { readInProgressGitOperation } from "./git-operation-state.mjs";
import { runGit } from "./git.mjs";
import { isTipAncestorOfTrunk } from "./landing.mjs";
import { readCompletedRebase, recordCompletedRebase } from "./rebase-completion.mjs";
import { saveProjectState } from "./registry.mjs";
import { assertCleanWorktree } from "./workspace-checks.mjs";

export async function rebaseTaskWithConflictRecovery(registry, slot, target) {
  const originalTip = await readTip(slot.path, "HEAD");
  const targetTip = await readTip(slot.path, target.revision);
  const originalCommitCount = await countCommits(slot.path, targetTip, originalTip);
  const recovery = {
    kind: "rebase",
    status: "rebasing",
    operationId: randomUUID(),
    originalTip,
    targetTip,
    originalCommitCount,
  };
  slot.recovery = recovery;
  await saveProjectState(registry);
  try {
    await runGit(slot.path, ["rebase", "--reapply-cherry-picks", "--empty=keep", target.revision]);
  } catch (error) {
    return handleFailedRebase(registry, slot, recovery, error);
  }
  const tip = await verifyRebasedTip(slot, target, targetTip);
  await assertCompletedRebase(slot, recovery, tip);
  delete slot.recovery;
  await saveProjectState(registry);
  return { status: "rebased", tip };
}

export async function finalizeRecoveredRebase(registry, operationId) {
  const completedOutcome = await readCompletedRebase(registry, operationId);
  if (completedOutcome) {
    const lingeringSlot = findRecoveringSlot(registry, operationId);
    if (lingeringSlot) {
      delete lingeringSlot.recovery;
      await saveProjectState(registry);
    }
    return completedOutcome;
  }
  const slot = findRecoveringSlot(registry, operationId);
  if (!slot) throw new Error("No Orchard rebase recovery matches the supplied operation ID");
  if (await readInProgressGitOperation(slot.path)) {
    throw new Error(`Task rebase '${slot.intent}' is still in progress`);
  }
  await proveBranchBinding({ projectRoot: registry.state.project.root, slot });
  await assertCleanWorktree(slot.path, "task worktree");
  const tip = await readTip(slot.path, "HEAD");
  const targetIntegrated = await isTipAncestorOfTrunk(slot.path, slot.recovery.targetTip, tip);
  const aborted = tip === slot.recovery.originalTip;
  if (!targetIntegrated && !aborted) {
    throw new Error(`Task rebase '${slot.intent}' is neither completed nor restored to its original tip`);
  }
  if (!aborted) await assertCompletedRebase(slot, slot.recovery, tip);
  const outcome = createFinalizedOutcome(registry.state.project, slot, {
    status: aborted ? "aborted" : "finalized",
    tip,
  });
  await recordCompletedRebase(registry, operationId, outcome);
  delete slot.recovery;
  await saveProjectState(registry);
  return outcome;
}

function findRecoveringSlot(registry, operationId) {
  return registry.state.slots.find((candidate) =>
    candidate.recovery?.kind === "rebase" && candidate.recovery.operationId === operationId);
}

function createFinalizedOutcome(project, slot, rebase) {
  return {
    project: { name: project.name, root: project.root, trunk: project.trunk },
    worktree: { path: slot.path, intent: slot.intent, branch: slot.branch },
    rebase: { status: rebase.status, tip: rebase.tip },
    transition: { kind: "none", targetPath: slot.path },
  };
}

async function assertCompletedRebase(slot, recovery, tip) {
  const rebasedCommitCount = await countCommits(slot.path, recovery.targetTip, tip);
  if (rebasedCommitCount !== recovery.originalCommitCount) {
    throw new Error(`Task branch '${slot.branch}' changed its task commit count during rebase`);
  }
  const wasAlreadyRebased = tip === recovery.originalTip
    && await isTipAncestorOfTrunk(slot.path, recovery.targetTip, recovery.originalTip);
  if (wasAlreadyRebased) return;
  const { stdout: action } = await runGit(slot.path, ["reflog", "show", "-1", "--format=%gs", slot.branch]);
  if (!action.startsWith("rebase (finish):")) {
    throw new Error(`Task branch '${slot.branch}' does not record a completed rebase`);
  }
}

async function handleFailedRebase(registry, slot, recovery, rebaseError) {
  const operation = await readInProgressGitOperation(slot.path);
  const unresolved = await readUnresolvedPaths(slot.path);
  if (operation === "rebase" && unresolved.length > 0) {
    slot.recovery = { ...recovery, status: "conflicted" };
    await saveProjectState(registry);
    return {
      status: "needs-conflict-resolution",
      operationId: recovery.operationId,
      originalTip: recovery.originalTip,
      targetTip: recovery.targetTip,
      unresolved,
    };
  }
  await abortAndClearRecovery(registry, slot, recovery.originalTip, rebaseError);
}

async function abortAndClearRecovery(registry, slot, originalTip, rebaseError) {
  try {
    if (await readInProgressGitOperation(slot.path) === "rebase") {
      await runGit(slot.path, ["rebase", "--abort"]);
    }
  } catch (abortError) {
    throw new AggregateError(
      [rebaseError, abortError],
      `Task rebase failed and its automatic abort also failed; recover the preserved worktree at ${slot.path}`,
    );
  }
  const restoredTip = await readTip(slot.path, "HEAD");
  if (restoredTip !== originalTip) {
    throw new Error(`Task rebase failed and abort did not restore the original tip at ${slot.path}`);
  }
  delete slot.recovery;
  await saveProjectState(registry);
  throw new Error(`Task rebase failed and was automatically aborted; the task tip was restored: ${rebaseError.message}`, { cause: rebaseError });
}

async function verifyRebasedTip(slot, target, targetTip) {
  if (!await isTipAncestorOfTrunk(slot.path, targetTip, slot.branch)) {
    throw new Error(`Rebased task '${slot.branch}' does not descend from base branch '${target.branch}'`);
  }
  return readTip(slot.path, "HEAD");
}

async function readUnresolvedPaths(worktreePath) {
  const { stdout } = await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  return stdout ? stdout.split("\0").filter(Boolean) : [];
}

async function countCommits(worktreePath, base, tip) {
  const { stdout } = await runGit(worktreePath, ["rev-list", "--count", `${base}..${tip}`]);
  const count = Number(stdout);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Git returned an invalid task commit count");
  return count;
}

async function readTip(worktreePath, revision) {
  const { stdout } = await runGit(worktreePath, ["rev-parse", revision]);
  return stdout;
}
