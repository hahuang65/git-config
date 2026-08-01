import { readFile } from "node:fs/promises";
import path from "node:path";

import { readTreehouseCapacity } from "./capacity.mjs";
import { findMainProjectDirectory, runGit } from "./git.mjs";
import { proveLanding } from "./landing.mjs";
import { withProjectLock } from "./lock.mjs";
import { isProcessAlive } from "./ownership.mjs";
import { recycleTask } from "./recycle-service.mjs";
import { findProjectRegistry, saveProjectState } from "./registry.mjs";

export async function pruneProject({ cwd, home, projectName, apply = false }) {
  const capacity = readTreehouseCapacity();
  const located = await locateRegistry({ cwd, home, projectName });
  const plan = await withProjectLock(located.directory, async () => {
    const registry = await locateRegistry({ cwd, home, projectName });
    return buildPrunePlan(registry, capacity);
  });
  if (!apply) return { applied: false, plan };
  for (const action of plan.recycle) {
    await recycleTask({ cwd: located.state.project.root, home, intent: action.intent });
  }
  const removed = await removeExcessAvailable({ cwd, home, projectName, capacity });
  return { applied: true, plan, removed };
}

async function locateRegistry({ cwd, home, projectName }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (projectRoot) {
    const registry = await findProjectRegistry({ home, projectRoot });
    if (registry) return registry;
  }
  if (!projectName) throw new Error("Specify a Treehouse project group outside a Git repository");
  const directory = path.join(home, ".treehouse", projectName);
  const statePath = path.join(directory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  return { directory, statePath, state };
}

async function buildPrunePlan(registry, capacity) {
  const tasks = registry.state.slots.filter((slot) => slot.lifecycle === "task");
  const available = registry.state.slots.filter((slot) => slot.lifecycle === "available");
  const recycle = [];
  for (const slot of tasks) {
    if (await isEligibleForRecycle(registry, slot)) recycle.push({ id: slot.id, intent: slot.intent, path: slot.path });
  }
  const totalCapacitySlots = tasks.length + available.length;
  const excess = Math.max(0, totalCapacitySlots - capacity);
  const removable = [
    ...available.map((slot) => ({ id: slot.id, path: slot.path })),
    ...recycle.map((slot) => ({ id: slot.id, path: slot.path, afterRecycle: true })),
  ];
  return { capacity, recycle, remove: removable.slice(0, excess) };
}

async function isEligibleForRecycle(registry, slot) {
  if (slot.recovery || (slot.owners ?? []).some((owner) => isProcessAlive(owner.pid))) return false;
  const { stdout: status } = await runGit(slot.path, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) return false;
  const { stdout: featureTip } = await runGit(slot.path, ["rev-parse", "HEAD"]);
  const proof = await proveLanding({
    projectRoot: registry.state.project.root,
    featureBranch: slot.branch,
    featureTip,
    trunk: registry.state.project.trunk,
  });
  return proof.status === "landed";
}

async function removeExcessAvailable({ cwd, home, projectName, capacity }) {
  const located = await locateRegistry({ cwd, home, projectName });
  return withProjectLock(located.directory, async () => {
    const registry = await locateRegistry({ cwd, home, projectName });
    const activeCount = registry.state.slots.filter((slot) => slot.lifecycle === "task").length;
    const available = registry.state.slots.filter((slot) => slot.lifecycle === "available");
    const removeCount = Math.min(available.length, Math.max(0, activeCount + available.length - capacity));
    const removed = [];
    for (const slot of available.slice(0, removeCount)) {
      await runGit(registry.state.project.root, ["worktree", "remove", slot.path]);
      registry.state.slots = registry.state.slots.filter((candidate) => candidate.id !== slot.id);
      await saveProjectState(registry);
      removed.push({ id: slot.id, path: slot.path });
    }
    return removed;
  });
}
