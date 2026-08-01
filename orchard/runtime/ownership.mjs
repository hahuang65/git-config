import { randomUUID } from "node:crypto";

export function claimTaskOwner(slot, { pid, shared = false }) {
  const liveOwners = (slot.owners ?? []).filter((owner) => isProcessAlive(owner.pid));
  const existingOwner = liveOwners.find((owner) => owner.pid === pid);
  if (liveOwners.length > 0 && !shared && !existingOwner) {
    throw new Error(`Task worktree '${slot.intent}' is already in use; pass --share to enter deliberately`);
  }
  if (existingOwner) {
    slot.owners = liveOwners;
    return existingOwner;
  }
  const owner = {
    token: randomUUID(),
    pid,
    shared,
    claimedAt: new Date().toISOString(),
  };
  slot.owners = [...liveOwners, owner];
  return owner;
}

export function refreshTaskOwners(slot) {
  slot.owners = (slot.owners ?? []).filter((owner) => isProcessAlive(owner.pid));
  return slot.owners;
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
