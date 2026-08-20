import { randomUUID } from "node:crypto";

export function createTaskSlot({ worktreePath, intent, branch, baseBranch }) {
  return {
    id: randomUUID(),
    lifecycle: "task",
    path: worktreePath,
    intent,
    branch,
    baseBranch,
    owners: [],
    createdAt: new Date().toISOString(),
  };
}

export function createTaskOutcome(project, slot) {
  return {
    project,
    worktree: {
      path: slot.path,
      intent: slot.intent,
      branch: slot.branch,
    },
    transition: {
      kind: "enter-worktree",
      operationId: randomUUID(),
      targetPath: slot.path,
    },
  };
}
