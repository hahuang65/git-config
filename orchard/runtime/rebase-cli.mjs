import { createMachineOutcome } from "./protocol.mjs";
import { finalizeRebaseOperation, rebaseTask } from "./rebase-service.mjs";

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const REBASE_HELP = `Synchronize the task's base branch, then rebase a clean managed task branch onto it.

Usage: orchard rebase [intent] [--resolve-conflicts] [--json]
       orchard rebase --finalize-operation <operation-id> --json

Options:
  --resolve-conflicts             Preserve an actual conflict for an owning workflow; requires --json.
  --finalize-operation <id>       Verify and clear one completed conflict-resolution operation; requires --json.
  --json                          Emit a versioned machine-readable outcome.

Safety: rebase requires clean task and main project directories, synchronizes the recorded base when it has an upstream, refuses divergence, and never pushes. Conflicts are automatically aborted unless an owning machine workflow requests resolution.
Failure: dirty, unmanaged, divergent, or non-conflict failures remain preserved; use the commit workflow before rebasing a dirty task.
`;

export function validateRebaseCliArgs(args, io) {
  const preserveConflicts = args.includes("--resolve-conflicts");
  const finalizeOperation = args.includes("--finalize-operation");
  if (preserveConflicts && finalizeOperation) {
    io.error("--resolve-conflicts cannot be combined with --finalize-operation");
    return 2;
  }
  if ((preserveConflicts || finalizeOperation) && !args.includes("--json")) {
    const option = preserveConflicts ? "--resolve-conflicts" : "--finalize-operation";
    io.error(`${option} requires --json`);
    return 2;
  }
  if (finalizeOperation && !OPERATION_ID_PATTERN.test(readOptionValue(args, "--finalize-operation") ?? "")) {
    io.error("--finalize-operation requires a valid operation ID");
    return 2;
  }
  return undefined;
}

export async function runRebaseCli(args, io) {
  const operationId = readOption(args, "--finalize-operation");
  const outcome = operationId
    ? await finalizeRebaseOperation({ cwd: process.cwd(), home: process.env.HOME, operationId })
    : await rebaseTask({
      cwd: process.cwd(),
      home: process.env.HOME,
      intent: args[1]?.startsWith("--") ? undefined : args[1],
      preserveConflicts: args.includes("--resolve-conflicts"),
    });
  io.log(args.includes("--json")
    ? JSON.stringify(createMachineOutcome("rebase", outcome))
    : `Rebased ${outcome.worktree.branch} onto ${outcome.rebase.baseBranch ?? outcome.project.trunk}`);
  return 0;
}

function readOption(args, option) {
  if (!args.includes(option)) return undefined;
  const value = readOptionValue(args, option);
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function readOptionValue(args, option) {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}
