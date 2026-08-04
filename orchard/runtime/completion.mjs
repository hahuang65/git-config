import { readOrchardStatus } from "./status.mjs";

const WORKTREE_TARGET_COMMANDS = new Set(["enter", "rebase", "merge", "recycle"]);
const PROJECT_TARGET_COMMANDS = new Set(["destroy", "prune"]);

export async function readCompletionCandidates(command, options = {}) {
  if (WORKTREE_TARGET_COMMANDS.has(command)) return readWorktreeCandidates(options);
  if (PROJECT_TARGET_COMMANDS.has(command)) return readProjectCandidates(options);
  return [];
}

async function readWorktreeCandidates(options) {
  const status = await readOrchardStatus(options);
  if (status.scope !== "project") return [];
  const intents = status.projects.flatMap((project) => project.slots
    .filter((slot) => slot.lifecycle === "task")
    .map((slot) => slot.intent)
    .filter(Boolean));
  return [...new Set(intents)].sort((left, right) => left.localeCompare(right));
}

async function readProjectCandidates(options) {
  const status = await readOrchardStatus(options);
  return status.projects.map((project) => project.name).sort((left, right) => left.localeCompare(right));
}
