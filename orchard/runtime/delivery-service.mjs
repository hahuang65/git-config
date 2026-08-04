import {
  assertNamedDeliveryUnoccupied,
  createNeedsCommitOutcome,
  inspectDeliveryTask,
} from "./delivery-inspection.mjs";
import { readDeliveryStrategy } from "./delivery-policy.mjs";
import { integrateTaskLocally } from "./local-delivery.mjs";
import { pathsReferToSameLocation } from "./paths.mjs";
import { deliverPullRequest } from "./pull-request-delivery.mjs";

export async function deliverTask({ cwd, home, intent, keep = false }) {
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

function createLocalDeliveryOutcome(outcome) {
  return {
    ...outcome,
    delivery: { status: "integrated", strategy: "local" },
  };
}
