import { readCompletionCandidates } from "./completion.mjs";
import { convertTaskBranch } from "./conversion-service.mjs";
import { destroyProject } from "./destroy-service.mjs";
import { runDeliverCli } from "./deliver-cli.mjs";
import { enterTask, releaseTaskOwner } from "./entry-service.mjs";
import { finalizeLocalDelivery } from "./local-delivery.mjs";
import { createMachineOutcome } from "./protocol.mjs";
import { pruneProject } from "./prune-service.mjs";
import { rebaseTask } from "./rebase-service.mjs";
import { recoverAllProjects } from "./recovery.mjs";
import { recycleTask } from "./recycle-service.mjs";
import { acquireTask } from "./service.mjs";
import { openManagedShell } from "./shell.mjs";
import { formatOrchardStatus, readOrchardStatus, shouldUseColor } from "./status.mjs";

const COMMAND_NAMES = Object.freeze(["new", "convert", "status", "enter", "rebase", "deliver", "recycle", "prune", "destroy"]);
const COMMANDS = new Set(COMMAND_NAMES);

const TOP_LEVEL_HELP = `Orchard manages reusable, branch-bound Git worktrees.

Usage: orchard [command]

Commands:
  new       Acquire a task worktree
  convert   Convert a local task branch
  status    Show managed worktrees (default)
  enter     Enter an existing task worktree
  rebase    Synchronize trunk and rebase a task branch
  deliver   Commit if requested, then apply project delivery policy
  recycle   Return landed work to the available pool
  prune     Preview or remove excess available worktrees
  destroy   Preview or destroy a project group

Conventions:
  status is the default when no command is given.
  --json emits versioned machine-readable output where supported.
  Interactive entry is disabled by --json and --print-path.

Compatibility:
  Node.js 22+ on macOS and Linux.

Run orchard <command> --help for command-specific help.
`;

const STATUS_HELP = `Show managed Orchard project groups and worktrees without mutation.

Usage: orchard status [--all] [--refresh] [--json]

Scope:
  Inside a Git repository, show only its registered project group.
  Outside a Git repository, show every registered project group.
  --all      Show every project even when invoked inside a repository.
  --refresh  Reconcile durable state with Git metadata before reporting.
  --json     Emit a versioned machine-readable outcome.

Safety: status is read-only unless --refresh requests conservative reconciliation.
Failure: unreadable or conflicting durable state is reported rather than guessed.
`;

const COMMAND_HELP = {
  new: `Acquire a managed task worktree for a new named branch.

Usage: orchard new <intent> [--offline] [--print-path | --json]

Options:
  --offline     Use local trunk without network synchronization.
  --print-path  Print only the acquired worktree path without entering it.
  --json        Emit a versioned transition outcome without entering it.

Safety: requires a clean main checkout on trunk and available project capacity.
Failure: synchronization, branch creation, or acquisition failure stops without evicting existing work.
`,
  convert: `Convert the current local task branch into a managed worktree.

Usage: orchard convert <intent> [--print-path | --json]

Options:
  --print-path  Print only the converted worktree path without entering it.
  --json        Emit a versioned transition outcome without entering it.

Safety: conversion requires a local task branch and preserves staged, unstaged, and untracked work; ignored files remain behind.
Failure: main, detached, already-linked, or unrecoverable conversion state is rejected without deleting source work.
`,
  status: STATUS_HELP,
  enter: `Enter an existing managed task worktree without changing its lifecycle.

Usage: orchard enter <intent> [--share] [--owner-pid <pid>] [--print-path | --json]
       orchard enter <intent> --release-owner <token> [--json]

Options:
  --share                  Permit concurrent ownership explicitly.
  --owner-pid <pid>        Record an automation caller process.
  --release-owner <token>  Release one exact ownership claim.
  --print-path             Print only the worktree path without entering it.
  --json                   Emit a versioned transition or release outcome.

Safety: concurrent entry is refused unless --share is explicit.
Failure: unknown tasks, invalid owners, and unsafe sharing stop without changing task lifecycle.
`,
  rebase: `Synchronize trunk, then rebase a clean managed task branch onto it.

Usage: orchard rebase [intent] [--json]

Options:
  --json  Emit a versioned machine-readable outcome.

Safety: rebase requires clean task and trunk worktrees, fast-forwards a behind trunk, accepts a local trunk ahead of upstream, refuses divergence, automatically aborts conflicts, and never pushes.
Failure: dirty, unmanaged, divergent, or conflicting work remains preserved; use the commit workflow before rebasing a dirty task.
`,
  deliver: `Commit if requested, then deliver a managed task according to trusted Git configuration.

Usage: orchard deliver [intent] [--keep] [--json]
       orchard deliver --finalize <intent> [--json]

Options:
  --keep               Preserve a locally integrated task worktree and branch.
  --finalize <intent>  Complete pending local-delivery cleanup by worktree name.
  --json               Never prompt; emit a versioned outcome, including needs-commit.

Safety: interactive delivery shows concise status and asks before opening Git commit; unstaged or untracked work uses Git interactive staging. Local delivery uses internal fast-forward integration, while pull-request delivery rebases and runs git pr create --web --fill only when publication is fast-forward safe.
Failure: declining commit exits unchanged; ambiguous policy, remote publication, dirty post-commit state, divergence, or rebase failure stops without force-pushing.
`,
  recycle: `Return one clean, landed, unoccupied task worktree to the available pool.

Usage: orchard recycle <intent> [--keep-branch] [--json]

Options:
  --keep-branch  Preserve the completed local branch.
  --json         Emit a versioned recycle outcome.

Safety: recycling requires clean, landed, unoccupied work and removes the local branch unless --keep-branch is set.
Failure: dirty, unlanded, occupied, or unverifiable tasks remain attached and registered.
`,
  prune: `Preview or apply conservative project-pool reduction.

Usage: orchard prune [project] [--apply] [--json]

Options:
  --apply  Apply the displayed plan; default behavior is preview-only.
  --json   Emit a versioned prune plan and outcome.

Safety: prune is preview-only by default, recycles eligible landed tasks first, and removes only excess available slots.
Failure: blocked tasks and unverifiable slots are preserved and reported.
`,
  destroy: `Preview or destroy one named Orchard project group.

Usage: orchard destroy [project] [--apply] [risk-options] [--json]

Options:
  --apply               Apply the displayed plan; default behavior is preview-only.
  --allow-unlanded      Permit removal of explicitly reported unlanded work.
  --allow-live-use      Permit removal despite explicitly reported live owners.
  --allow-unverifiable  Permit removal of explicitly reported unverifiable state.
  --delete-branches     Permit deletion of explicitly reported local branches.
  --json                Emit a versioned destruction plan and outcome.

Safety: destruction is preview-only by default, each risk gate is independent, and a named request never broadens to every project.
Failure: missing gates stop application, and partial failure leaves surviving work registered or reconstructable.
`,
};

export async function runOrchardCli(args, io = console) {
  if (args[0] === "--help" || args[0] === "-h") {
    io.log(TOP_LEVEL_HELP);
    return 0;
  }
  const command = args[0] ?? "status";
  if (command === "__complete") {
    const candidates = args[1]
      ? await readCompletionCandidates(args[1], { cwd: process.cwd(), home: process.env.HOME })
      : COMMAND_NAMES;
    if (candidates.length > 0) io.log(candidates.join("\n"));
    return 0;
  }
  if (COMMANDS.has(command) && (args.includes("--help") || args.includes("-h"))) {
    io.log(COMMAND_HELP[command]);
    return 0;
  }
  if (command === "status") {
    if (args.includes("--refresh")) await recoverAllProjects({ home: process.env.HOME });
    const status = await readOrchardStatus({ all: args.includes("--all") });
    const output = args.includes("--json")
      ? JSON.stringify(createMachineOutcome(command, { projects: status.projects }))
      : formatOrchardStatus(status, { color: shouldUseColor() });
    io.log(output);
    return 0;
  }
  const mutatingCommand = !["prune", "destroy"].includes(command) || args.includes("--apply");
  if (COMMANDS.has(command) && mutatingCommand && !args.includes("--help") && !args.includes("-h")) {
    await recoverAllProjects({ home: process.env.HOME });
  }
  if (command === "destroy") {
    const outcome = await destroyProject({
      cwd: process.cwd(),
      home: process.env.HOME,
      projectName: args[1]?.startsWith("--") ? undefined : args[1],
      apply: args.includes("--apply"),
      gates: {
        allowUnlanded: args.includes("--allow-unlanded"),
        allowLiveUse: args.includes("--allow-live-use"),
        allowUnverifiable: args.includes("--allow-unverifiable"),
        deleteBranches: args.includes("--delete-branches"),
      },
    });
    io.log(args.includes("--json")
      ? JSON.stringify(createMachineOutcome(command, outcome))
      : `${outcome.applied ? "Applied" : "Preview"}: ${outcome.plan.worktrees.length} worktree(s)`);
    return 0;
  }
  if (command === "prune") {
    const outcome = await pruneProject({
      cwd: process.cwd(),
      home: process.env.HOME,
      projectName: args[1]?.startsWith("--") ? undefined : args[1],
      apply: args.includes("--apply"),
    });
    io.log(args.includes("--json")
      ? JSON.stringify(createMachineOutcome(command, outcome))
      : `${outcome.applied ? "Applied" : "Preview"}: ${outcome.plan.remove.length} removable slot(s)`);
    return 0;
  }
  if (command === "rebase") {
    const outcome = await rebaseTask({
      cwd: process.cwd(),
      home: process.env.HOME,
      intent: args[1]?.startsWith("--") ? undefined : args[1],
    });
    io.log(args.includes("--json")
      ? JSON.stringify(createMachineOutcome(command, outcome))
      : `Rebased ${outcome.worktree.branch} onto ${outcome.project.trunk}`);
    return 0;
  }
  if (command === "deliver") return runDeliverCli(args, io);
  if (command === "recycle") {
    const outcome = await recycleTask({
      cwd: process.cwd(),
      home: process.env.HOME,
      intent: args[1]?.startsWith("--") ? undefined : args[1],
      keepBranch: args.includes("--keep-branch"),
    });
    io.log(args.includes("--json")
      ? JSON.stringify(createMachineOutcome(command, outcome))
      : `Recycled ${outcome.slot.path}`);
    return 0;
  }
  if (command === "convert") {
    const outcome = await convertTaskBranch({
      cwd: process.cwd(),
      home: process.env.HOME,
      requestedIntent: args[1],
    });
    if (args.includes("--json")) io.log(JSON.stringify(createMachineOutcome(command, outcome)));
    else if (args.includes("--print-path")) io.log(outcome.worktree.path);
    else {
      io.log(`Entering ${outcome.worktree.path}`);
      await runManagedTaskShell(outcome);
    }
    return 0;
  }
  if (command === "enter") {
    const releaseToken = readOption(args, "--release-owner");
    if (releaseToken) {
      const released = await releaseTaskOwner({
        cwd: process.cwd(),
        home: process.env.HOME,
        intent: args[1],
        token: releaseToken,
      });
      io.log(args.includes("--json")
        ? JSON.stringify(createMachineOutcome(command, { released, ownerToken: releaseToken }))
        : (released ? "Released Orchard owner" : "Orchard owner was already released"));
      return 0;
    }
    const outcome = await enterTask({
      cwd: process.cwd(),
      home: process.env.HOME,
      intent: args[1],
      ownerPid: readIntegerOption(args, "--owner-pid") ?? process.ppid,
      shared: args.includes("--share"),
    });
    if (args.includes("--json")) io.log(JSON.stringify(createMachineOutcome(command, outcome)));
    else if (args.includes("--print-path")) io.log(outcome.worktree.path);
    else {
      io.log(`Entering ${outcome.worktree.path}`);
      await runManagedTaskShell(outcome, async () => {
        await releaseTaskOwner({
          cwd: process.cwd(),
          home: process.env.HOME,
          intent: outcome.worktree.intent,
          token: outcome.owner.token,
        });
      });
    }
    return 0;
  }
  if (command === "new") {
    const outcome = await acquireTask({
      cwd: process.cwd(),
      home: process.env.HOME,
      requestedIntent: args[1],
      offline: args.includes("--offline"),
    });
    if (args.includes("--json")) {
      io.log(JSON.stringify(createMachineOutcome(command, outcome)));
    } else if (args.includes("--print-path")) {
      io.log(outcome.worktree.path);
    } else {
      io.log(`Entering ${outcome.worktree.path}`);
      await runManagedTaskShell(outcome);
    }
    return 0;
  }
  if (!COMMANDS.has(command)) {
    const migration = command === "merge" ? "\nUse 'orchard deliver' instead." : "";
    io.error(`Unknown command: ${command}${migration}\nRun orchard --help for usage.`);
    return 2;
  }
  io.log(TOP_LEVEL_HELP);
  return 0;
}

async function runManagedTaskShell(outcome, releaseOwner = async () => {}) {
  let shellResult;
  try {
    shellResult = await openManagedShell(outcome.worktree.path);
  } finally {
    await releaseOwner();
  }
  if (shellResult.returnRequest) {
    await finalizeLocalDelivery({
      cwd: outcome.project.root,
      home: process.env.HOME,
      operationId: shellResult.returnRequest.operationId,
    });
  }
}

function readOption(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function readIntegerOption(args, option) {
  const rawValue = readOption(args, option);
  if (rawValue === undefined) return undefined;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${option} requires a positive integer`);
  return value;
}
