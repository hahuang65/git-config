import { createMachineOutcome } from "./protocol.mjs";
import { promptToCommit } from "./delivery-commit.mjs";
import { deliverTask } from "./delivery-service.mjs";
import { finalizeLocalDelivery } from "./local-delivery.mjs";
import { writeManagedReturnRequest } from "./managed-return.mjs";

export async function runDeliverCli(args, io = console) {
  const json = args.includes("--json");
  const finalizeIntent = readOption(args, "--finalize");
  const finalizeOperation = readOption(args, "--finalize-operation");
  if (finalizeIntent && finalizeOperation) {
    throw new Error("Choose either worktree finalization or internal operation finalization");
  }
  if (finalizeIntent || finalizeOperation) {
    return runFinalization({ io, json, intent: finalizeIntent, operationId: finalizeOperation });
  }
  const intent = args[1]?.startsWith("--") ? undefined : args[1];
  const options = {
    cwd: process.cwd(),
    home: process.env.HOME,
    intent,
    keep: args.includes("--keep"),
  };
  let outcome = await deliverTask(options);
  if (outcome.delivery.status === "needs-commit") {
    if (json) {
      io.log(JSON.stringify(createMachineOutcome("deliver", outcome)));
      return 0;
    }
    const commit = await promptToCommit({
      worktreePath: outcome.worktree.path,
      status: outcome.commit.status,
    });
    if (commit.status === "cancelled") {
      io.log("Delivery cancelled");
      return 0;
    }
    if (commit.status === "incomplete") {
      io.error("Delivery requires a clean task worktree; finish committing and retry");
      return 1;
    }
    outcome = await deliverTask(options);
  }

  if (json) {
    io.log(JSON.stringify(createMachineOutcome("deliver", outcome)));
    return 0;
  }
  await reportDelivery(outcome, io);
  return 0;
}

async function reportDelivery(outcome, io) {
  if (outcome.delivery.strategy === "pull-request") {
    io.log(`Opened pull-request form for ${outcome.worktree.branch}`);
    return;
  }
  io.log(`Fast-forwarded ${outcome.project.trunk} to ${outcome.integration.tip}`);
  if (outcome.transition.kind !== "return-main") return;
  const requested = await writeManagedReturnRequest(outcome.transition);
  if (!requested) {
    io.log(`Return to ${outcome.transition.targetPath}, then run orchard deliver --finalize ${outcome.worktree.intent}`);
  }
}

async function runFinalization({ io, json, intent, operationId }) {
  const finalized = await finalizeLocalDelivery({
    cwd: process.cwd(),
    home: process.env.HOME,
    intent,
    operationId,
  });
  const outcome = {
    ...finalized,
    delivery: { status: "finalized", strategy: "local" },
    transition: { kind: "none", targetPath: finalized.project.root },
  };
  io.log(json
    ? JSON.stringify(createMachineOutcome("deliver", outcome))
    : `Completed delivery cleanup for ${intent ?? operationId}`);
  return 0;
}

function readOption(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
