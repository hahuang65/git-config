import {
  assertNamedDeliveryUnoccupied,
  createNeedsCommitOutcome,
  inspectDeliveryTask,
  inspectOrdinaryBranch,
} from "./delivery-inspection.mjs";
import { readDeliveryStrategy } from "./delivery-policy.mjs";
import { integrateTaskLocally } from "./local-delivery.mjs";
import { integrateOrdinaryBranch } from "./ordinary-branch-delivery.mjs";
import { pathsReferToSameLocation } from "./paths.mjs";
import { deliverOrdinaryBranchPullRequest, deliverPullRequest } from "./pull-request-delivery.mjs";

export async function deliverTask({ cwd, home, intent, keep = false }) {
  const ordinaryBranch = await inspectOrdinaryBranch({ cwd, home, intent });
  if (ordinaryBranch) return deliverOrdinaryBranch({ inspection: ordinaryBranch, keep });

  const inspection = await inspectDeliveryTask({ cwd, home, intent });
  const calledFromMain = inspection.callerRoot
    && await pathsReferToSameLocation(inspection.callerRoot, inspection.projectRoot);
  if (calledFromMain) {
    await assertNamedDeliveryUnoccupied({
      home,
      projectRoot: inspection.projectRoot,
      intent: inspection.slot.intent,
    });
  }
  if (inspection.status) {
    return createNeedsCommitOutcome(inspection.registry, inspection.slot, inspection.status);
  }

  const strategy = await readDeliveryStrategy(inspection.projectRoot);
  if (strategy === "pull-request") return deliverPullRequest({ cwd, home, intent });

  const integrated = await integrateTaskLocally({
    cwd,
    home,
    intent,
    keep,
    invokedFromMain: Boolean(calledFromMain),
    finalizeImmediately: Boolean(calledFromMain && !keep),
  });
  return createLocalDeliveryOutcome(integrated);
}

async function deliverOrdinaryBranch({ inspection, keep }) {
  if (inspection.status) {
    return createNeedsCommitOutcome(inspection.project, inspection.slot, inspection.status);
  }
  const strategy = await readDeliveryStrategy(inspection.projectRoot);
  if (strategy === "pull-request") return deliverOrdinaryBranchPullRequest(inspection);
  return createLocalDeliveryOutcome(await integrateOrdinaryBranch({ inspection, keep }));
}

function createLocalDeliveryOutcome(outcome) {
  return {
    ...outcome,
    delivery: { status: "integrated", strategy: "local" },
  };
}
