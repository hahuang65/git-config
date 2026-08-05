import { QUARANTINE_CODES } from "./quarantine.mjs";
import { readOrchardStatus } from "./status.mjs";

const WORKTREE_TARGET_COMMANDS = new Set(["enter", "rebase", "deliver", "recycle"]);
const PROJECT_TARGET_COMMANDS = new Set(["destroy", "prune"]);

export async function readCompletionCandidates(command, options = {}) {
  if (command === "repair") return readRepairCandidates(options);
  if (WORKTREE_TARGET_COMMANDS.has(command)) return readWorktreeCandidates(options);
  if (PROJECT_TARGET_COMMANDS.has(command)) return readProjectCandidates(options);
  return [];
}

function readWorktreeCandidates(options) {
  return readIntentCandidates(options, (slot) => slot.lifecycle === "task");
}

function readRepairCandidates(options) {
  return readIntentCandidates(options, (slot) => slot.lifecycle === "quarantined"
    && slot.quarantine?.code === QUARANTINE_CODES.branchMismatch);
}

async function readIntentCandidates(options, isCandidate) {
  const status = await readOrchardStatus(options);
  if (status.scope !== "project") return [];
  const intents = status.projects.flatMap((project) => project.slots
    .filter(isCandidate)
    .map((slot) => slot.intent)
    .filter(Boolean));
  return [...new Set(intents)].sort((left, right) => left.localeCompare(right));
}

async function readProjectCandidates(options) {
  const status = await readOrchardStatus(options);
  return status.projects.map((project) => project.name).sort((left, right) => left.localeCompare(right));
}
