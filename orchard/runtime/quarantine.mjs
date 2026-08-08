export const QUARANTINE_CODES = Object.freeze({
  branchMismatch: "branch-mismatch",
  missingWorktreeMetadata: "missing-worktree-metadata",
  availableBranchConflict: "available-branch-conflict",
  duplicateRegistration: "duplicate-registration",
  duplicateGitRegistration: "duplicate-git-registration",
  managedPathRoleConflict: "managed-path-role-conflict",
  missingTaskBranch: "missing-task-branch",
  prunableWorktreeRegistration: "prunable-worktree-registration",
  reconstructedRoleConflict: "reconstructed-role-conflict",
  rebaseRecoveryConflict: "rebase-recovery-conflict",
});

export function createQuarantineEvidence({
  code,
  reason,
  details = {},
  detectedAt = new Date().toISOString(),
}) {
  return { code, reason, ...details, detectedAt };
}
