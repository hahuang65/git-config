import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { runGit } from "./git.mjs";
import { refreshTaskOwners } from "./ownership.mjs";
import { canonicalPath } from "./paths.mjs";
import { saveProjectState } from "./registry.mjs";

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
  const metadata = parseWorktreeMetadata((await runGit(candidates[0], ["worktree", "list", "--porcelain"])).stdout);
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
  const metadata = candidates.length
    ? parseWorktreeMetadata((await runGit(candidates[0], ["worktree", "list", "--porcelain"])).stdout)
    : [];
  for (const slot of state.slots) {
    if (slot.lifecycle === "quarantined") continue;
    const slotPath = await canonicalPath(slot.path);
    const actual = await findWorktreeByPath(metadata, slotPath);
    const reason = registrationConflict(slot, actual);
    if (reason) {
      slot.lifecycle = "quarantined";
      slot.quarantine = { reason };
    }
  }
  quarantineDuplicateRegistrations(state.slots);
  return JSON.stringify(state) !== before;
}

async function findWorktreeByPath(metadata, slotPath) {
  for (const worktree of metadata) {
    if (await canonicalPath(worktree.path) === slotPath) return worktree;
  }
  return undefined;
}

function registrationConflict(slot, actual) {
  if (!actual) return "Registered path is missing from Git worktree metadata";
  if (slot.lifecycle === "task" && actual.branch !== slot.branch) {
    return `Registered branch '${slot.branch}' conflicts with Git branch '${actual.branch ?? "detached HEAD"}'`;
  }
  if (slot.lifecycle === "available" && actual.branch) {
    return `Available slot unexpectedly has branch '${actual.branch}' checked out`;
  }
  return undefined;
}

function quarantineDuplicateRegistrations(slots) {
  const active = slots.filter((slot) => slot.lifecycle !== "quarantined");
  for (const slot of active) {
    const duplicate = active.find((candidate) => candidate !== slot
      && (candidate.path === slot.path || (slot.branch && candidate.branch === slot.branch)));
    if (duplicate) {
      slot.lifecycle = "quarantined";
      slot.quarantine = { reason: "Duplicate managed path or branch registration" };
    }
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

function parseWorktreeMetadata(output) {
  return output.split("\n\n").filter(Boolean).map((block) => {
    const fields = Object.fromEntries(block.split("\n").filter((line) => line.includes(" ")).map((line) => {
      const separator = line.indexOf(" ");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return {
      path: fields.worktree,
      head: fields.HEAD,
      branch: fields.branch?.replace("refs/heads/", ""),
    };
  });
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
    ...(conflict ? { quarantine: { reason: "Git metadata conflicts with the managed path role" } } : {}),
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
