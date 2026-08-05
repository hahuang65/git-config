import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { inspectBranchBinding } from "./branch-binding-verifier.mjs";
import { withProjectLock } from "./lock.mjs";
import { refreshTaskOwners } from "./ownership.mjs";
import { canonicalPath } from "./paths.mjs";
import { createQuarantineEvidence, QUARANTINE_CODES } from "./quarantine.mjs";
import { saveProjectState } from "./registry.mjs";
import { readWorktreeMetadata } from "./worktree-metadata.mjs";

export async function recoverAllProjects({ home }) {
  const orchardRoot = path.join(home, ".orchard");
  let entries;
  try {
    entries = await readdir(orchardRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && !candidate.name.startsWith("."))) {
    await recoverProjectGroup(path.join(orchardRoot, entry.name));
  }
}

export async function recoverProjectGroup(directory) {
  return withProjectLock(directory, () => recoverProjectGroupUnderLock(directory));
}

async function recoverProjectGroupUnderLock(directory) {
  const statePath = path.join(directory, "state.json");
  const validState = await readValidState(statePath);
  if (validState) {
    if (await reconcileValidState(directory, validState)) {
      await saveProjectState({ statePath, state: validState });
    }
    return;
  }
  const candidates = await findManagedCandidates(directory);
  if (candidates.length === 0) return;
  const metadata = await readWorktreeMetadata(candidates[0]);
  const project = metadata[0];
  if (!project?.branch) return;
  const displayPaths = new Map(await Promise.all(candidates.map(async (candidate) => [await canonicalPath(candidate), candidate])));
  const slots = [];
  for (const worktree of metadata.slice(1)) {
    const displayPath = displayPaths.get(await canonicalPath(worktree.path));
    if (!displayPath) continue;
    slots.push(createRecoveredSlot(directory, project.path, displayPath, worktree));
  }
  const state = {
    version: 1,
    project: { name: path.basename(directory), root: project.path, trunk: project.branch },
    slots,
  };
  await saveProjectState({ statePath, state });
}

async function reconcileValidState(directory, state) {
  const before = JSON.stringify(state);
  for (const slot of state.slots) refreshTaskOwners(slot);
  const candidates = await findManagedCandidates(directory);
  const metadata = candidates.length ? await readWorktreeMetadata(candidates[0]) : [];
  for (const slot of state.slots) {
    if (slot.lifecycle === "quarantined") continue;
    const slotPath = await canonicalPath(slot.path);
    const pathMatches = await findWorktreesByPath(metadata, slotPath);
    const quarantine = await registrationConflict(directory, slot, pathMatches, metadata);
    if (quarantine) {
      slot.lifecycle = "quarantined";
      slot.quarantine = quarantine;
    }
  }
  await quarantineDuplicateRegistrations(state.slots);
  return JSON.stringify(state) !== before;
}

async function findWorktreesByPath(metadata, slotPath) {
  const matches = [];
  for (const worktree of metadata) {
    if (await canonicalPath(worktree.path) === slotPath) matches.push(worktree);
  }
  return matches;
}

async function registrationConflict(directory, slot, pathMatches, metadata) {
  if (pathMatches.length === 0) {
    return createQuarantineEvidence({
      code: QUARANTINE_CODES.missingWorktreeMetadata,
      reason: "Registered path is missing from Git worktree metadata",
    });
  }
  const actual = pathMatches[0];
  if (actual.prunable) {
    return createQuarantineEvidence({
      code: QUARANTINE_CODES.prunableWorktreeRegistration,
      reason: "Git worktree registration is prunable because its worktree is missing",
    });
  }
  const branchMatches = slot.branch
    ? metadata.filter((worktree) => worktree.branch === slot.branch)
    : [];
  if (pathMatches.length > 1 || branchMatches.length > 1) {
    return createQuarantineEvidence({
      code: QUARANTINE_CODES.duplicateGitRegistration,
      reason: "Git worktree metadata contains a duplicate managed path or branch",
      details: {
        expectedBranch: slot.branch,
        observedBranch: actual.branch ?? null,
        matchingPathEntries: pathMatches.length,
        matchingBranchEntries: branchMatches.length,
      },
    });
  }
  if (slot.lifecycle === "available" && actual.branch) {
    return createQuarantineEvidence({
      code: QUARANTINE_CODES.availableBranchConflict,
      reason: `Available slot unexpectedly has branch '${actual.branch}' checked out`,
      details: { observedBranch: actual.branch, observedCommit: actual.head },
    });
  }
  if (!await hasValidManagedPathRole(directory, slot)) {
    return createQuarantineEvidence({
      code: QUARANTINE_CODES.managedPathRoleConflict,
      reason: "Managed worktree path conflicts with its lifecycle role",
    });
  }
  if (slot.lifecycle === "task") {
    return inspectBranchBinding({
      expectedBranch: slot.branch,
      observedBranch: actual.branch ?? null,
      observedCommit: actual.head,
    });
  }
  return undefined;
}

async function hasValidManagedPathRole(directory, slot) {
  if (slot.lifecycle === "task") {
    if (!slot.intent) return false;
    return await canonicalPath(slot.path) === await canonicalPath(path.join(directory, slot.intent));
  }
  if (slot.lifecycle !== "available") return true;
  return await canonicalPath(path.dirname(slot.path)) === await canonicalPath(path.join(directory, ".pool"));
}

async function quarantineDuplicateRegistrations(slots) {
  const canonicalPaths = await Promise.all(slots.map((slot) => canonicalPath(slot.path)));
  for (const [index, slot] of slots.entries()) {
    const hasDuplicate = slots.some((candidate, candidateIndex) => candidate !== slot
      && (canonicalPaths[candidateIndex] === canonicalPaths[index]
        || (slot.branch && candidate.branch === slot.branch)));
    if (!hasDuplicate || slot.lifecycle === "quarantined") continue;
    slot.lifecycle = "quarantined";
    slot.quarantine = createQuarantineEvidence({
      code: QUARANTINE_CODES.duplicateRegistration,
      reason: "Duplicate managed path or branch registration",
    });
  }
}

async function findManagedCandidates(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const candidatePath = path.join(directory, entry.name);
    if (entry.name === ".pool") {
      const poolEntries = await readdir(candidatePath, { withFileTypes: true });
      candidates.push(...poolEntries.filter((candidate) => candidate.isDirectory()).map((candidate) => path.join(candidatePath, candidate.name)));
    } else if (!entry.name.startsWith(".")) {
      candidates.push(candidatePath);
    }
  }
  const checked = await Promise.all(candidates.map(async (candidate) => {
    try {
      await access(path.join(candidate, ".git"));
      return candidate;
    } catch {
      return undefined;
    }
  }));
  return checked.filter(Boolean);
}

function createRecoveredSlot(directory, projectRoot, displayPath, worktree) {
  const inPool = path.dirname(displayPath) === path.join(directory, ".pool");
  const conflict = inPool ? Boolean(worktree.branch) : !worktree.branch;
  return {
    id: createHash("sha256").update(`${projectRoot}\0${displayPath}`).digest("hex").slice(0, 16),
    lifecycle: conflict ? "quarantined" : (inPool ? "available" : "task"),
    path: displayPath,
    intent: inPool ? null : path.basename(displayPath),
    branch: worktree.branch ?? null,
    owners: [],
    landing: "unknown",
    ...(conflict ? {
      quarantine: createQuarantineEvidence({
        code: QUARANTINE_CODES.reconstructedRoleConflict,
        reason: "Git metadata conflicts with the managed path role",
      }),
    } : {}),
  };
}

async function readValidState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return state?.version === 1 && state?.project && Array.isArray(state.slots) ? state : undefined;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
