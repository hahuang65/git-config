import { createInterface } from "node:readline/promises";

import { runGit, runGitInteractive } from "./git.mjs";

export function commitArgumentsForStatus(status) {
  const hasUnstagedOrUntracked = status.split("\n").some((line) => {
    if (!line) return false;
    return line.startsWith("??") || line[1] !== " ";
  });
  return hasUnstagedOrUntracked ? ["commit", "--interactive"] : ["commit"];
}

export async function promptToCommit({
  worktreePath,
  status,
  input = process.stdin,
  output = process.stdout,
  runInteractive = runGitInteractive,
  readStatus = readWorktreeStatus,
}) {
  output.write(`Uncommitted changes:\n${status}\n`);
  const confirmed = await confirmCommit(input, output);
  if (!confirmed) return { status: "cancelled" };

  await runInteractive(worktreePath, commitArgumentsForStatus(status));
  const remaining = await readStatus(worktreePath);
  if (remaining) {
    output.write(`Uncommitted changes remain:\n${remaining}\n`);
    return { status: "incomplete", remaining };
  }
  return { status: "committed" };
}

async function readWorktreeStatus(worktreePath) {
  const { stdout } = await runGit(worktreePath, ["status", "--short"]);
  return stdout;
}

async function confirmCommit(input, output) {
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question("Commit these changes before delivery? [y/N] ");
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
