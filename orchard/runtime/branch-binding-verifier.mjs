import { canonicalPath } from "./paths.mjs";
import { createQuarantineEvidence, QUARANTINE_CODES } from "./quarantine.mjs";
import { readWorktreeMetadata } from "./worktree-metadata.mjs";

export async function proveBranchBinding({ projectRoot, slot }) {
  const metadata = await readWorktreeMetadata(projectRoot);
  const registeredPath = await canonicalPath(slot.path);
  const pathMatches = [];
  for (const worktree of metadata) {
    if (await canonicalPath(worktree.path) === registeredPath) pathMatches.push(worktree);
  }
  if (pathMatches.length === 0) {
    throw new Error(`Task worktree '${slot.intent}' registered path is missing from Git worktree metadata`);
  }
  if (pathMatches.length > 1) {
    throw new Error(`Task worktree '${slot.intent}' has duplicate Git path metadata`);
  }
  const observed = pathMatches[0];
  if (observed.branch !== slot.branch) {
    const observedBranch = observed.branch ?? "detached HEAD";
    throw new Error(`Task worktree '${slot.intent}' expected branch '${slot.branch}' but observed '${observedBranch}'`);
  }
  const branchMatches = metadata.filter((worktree) => worktree.branch === slot.branch);
  if (branchMatches.length > 1) {
    throw new Error(`Task branch '${slot.branch}' has duplicate Git branch metadata`);
  }
  if (branchMatches.length !== 1 || observed !== branchMatches[0]) {
    throw new Error(`Task branch '${slot.branch}' is not bound to the registered Git path`);
  }
  return {
    canonicalPath: registeredPath,
    assignedBranch: slot.branch,
    observedBranch: observed.branch,
    observedCommit: observed.head,
    matchingPathEntries: pathMatches.length,
    matchingBranchEntries: branchMatches.length,
  };
}

export function inspectBranchBinding({
  expectedBranch,
  observedBranch,
  observedCommit,
  detectedAt = new Date().toISOString(),
}) {
  if (typeof expectedBranch !== "string" || !expectedBranch.trim()) {
    return createQuarantineEvidence({
      code: QUARANTINE_CODES.missingTaskBranch,
      reason: "Managed task has no assigned branch",
      details: { observedBranch, observedCommit },
      detectedAt,
    });
  }
  if (expectedBranch === observedBranch) return undefined;
  const observedLabel = observedBranch ?? "detached HEAD";
  return createQuarantineEvidence({
    code: QUARANTINE_CODES.branchMismatch,
    reason: `Registered branch '${expectedBranch}' conflicts with Git branch '${observedLabel}'`,
    details: { expectedBranch, observedBranch, observedCommit },
    detectedAt,
  });
}
