import { rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { runGit } from "./git.mjs";
import { proveLanding } from "./landing.mjs";
import { withProjectLock } from "./lock.mjs";
import { isProcessAlive } from "./ownership.mjs";
import { locateProjectRegistry } from "./project-locator.mjs";
import { saveProjectState } from "./registry.mjs";
import { resolveTaskBaseBranch } from "./task-base.mjs";

export async function destroyProject({ cwd, home, projectName, apply = false, gates = {} }) {
  const located = await locateProjectRegistry({ cwd, home, projectName });
  const plan = await withProjectLock(located.directory, async () => {
    const registry = await locateProjectRegistry({ cwd, home, projectName });
    return buildDestroyPlan(registry);
  });
  if (!apply) return { applied: false, ...plan };
  assertRiskGates(plan.risks, gates);
  const result = await applyDestroy({ cwd, home, projectName, plan, gates });
  return { applied: true, ...plan, ...result };
}

async function buildDestroyPlan(registry) {
  const worktrees = [];
  let unlanded = false;
  let liveUse = false;
  let unverifiable = false;
  for (const slot of registry.state.slots) {
    const assessment = await assessSlot(registry, slot);
    worktrees.push({
      id: slot.id,
      path: slot.path,
      lifecycle: slot.lifecycle,
      branch: slot.branch,
      ...assessment,
    });
    unlanded ||= assessment.unlanded;
    liveUse ||= assessment.liveUse;
    unverifiable ||= assessment.unverifiable;
  }
  const branches = [...new Set(worktrees.map((worktree) => worktree.branch).filter(Boolean))];
  return {
    project: registry.state.project,
    risks: { unlanded, liveUse, unverifiable, branchDeletion: branches.length > 0 },
    plan: { worktrees, branches },
  };
}

async function assessSlot(registry, slot) {
  const liveUse = (slot.owners ?? []).some((owner) => isProcessAlive(owner.pid));
  if (slot.lifecycle === "quarantined" || slot.recovery) {
    return { dirty: true, landing: "unverifiable", unlanded: true, liveUse, unverifiable: true };
  }
  const { stdout: status } = await runGit(slot.path, ["status", "--porcelain", "--untracked-files=normal"]);
  const dirty = Boolean(status);
  if (slot.lifecycle === "available") {
    return { dirty, landing: "not-applicable", unlanded: dirty, liveUse, unverifiable: false };
  }
  const { stdout: featureTip } = await runGit(slot.path, ["rev-parse", "HEAD"]);
  const baseBranch = await resolveTaskBaseBranch(registry, slot);
  const proof = await proveLanding({
    projectRoot: registry.state.project.root,
    featureBranch: slot.branch,
    featureTip,
    trunk: baseBranch,
  });
  return {
    baseBranch,
    dirty,
    landing: proof.status,
    unlanded: dirty || proof.status !== "landed",
    liveUse,
    unverifiable: proof.status === "unverifiable",
  };
}

async function applyDestroy({ cwd, home, projectName, plan, gates }) {
  const located = await locateProjectRegistry({ cwd, home, projectName });
  const result = await withProjectLock(located.directory, async () => {
    const registry = await locateProjectRegistry({ cwd, home, projectName });
    const removed = [];
    const deletedBranches = [];
    for (const worktree of plan.plan.worktrees) {
      const slot = registry.state.slots.find((candidate) => candidate.id === worktree.id);
      if (!slot) continue;
      const removeArgs = ["worktree", "remove"];
      if (worktree.dirty || worktree.liveUse || worktree.unverifiable) removeArgs.push("--force");
      removeArgs.push(slot.path);
      await runGit(registry.state.project.root, removeArgs);
      registry.state.slots = registry.state.slots.filter((candidate) => candidate.id !== slot.id);
      await saveProjectState(registry);
      removed.push({ id: slot.id, path: slot.path });
      if (gates.deleteBranches && worktree.branch) {
        const mergedIntoHead = worktree.baseBranch === registry.state.project.trunk;
        const deleteOption = worktree.unlanded || worktree.unverifiable || !mergedIntoHead ? "-D" : "-d";
        await runGit(registry.state.project.root, ["branch", deleteOption, worktree.branch]);
        deletedBranches.push(worktree.branch);
      }
    }
    return { removed, deletedBranches, empty: registry.state.slots.length === 0 };
  });
  if (result.empty) await removeEmptyProjectGroup(located);
  return { removed: result.removed, deletedBranches: result.deletedBranches };
}

async function removeEmptyProjectGroup(registry) {
  await unlink(registry.statePath);
  await rmdir(path.join(registry.directory, ".pool")).catch((error) => {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  });
  await rmdir(registry.directory).catch((error) => {
    if (error?.code !== "ENOTEMPTY") throw error;
  });
}

function assertRiskGates(risks, gates) {
  const missing = [];
  if (risks.unlanded && !gates.allowUnlanded) missing.push("--allow-unlanded");
  if (risks.liveUse && !gates.allowLiveUse) missing.push("--allow-live-use");
  if (risks.unverifiable && !gates.allowUnverifiable) missing.push("--allow-unverifiable");
  if (risks.branchDeletion && gates.deleteBranches !== true) {
    // Worktrees may be removed while local branches are retained.
  }
  if (missing.length) throw new Error(`Destroy blocked; supply ${missing.join(", ")}`);
}
