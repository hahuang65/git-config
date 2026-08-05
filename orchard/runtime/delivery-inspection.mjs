import { findMainProjectDirectory, findRemoteTrunk, findRepositoryRoot, runGit } from "./git.mjs";
import { resolveTaskSlot } from "./integration.mjs";
import { withProjectLock } from "./lock.mjs";
import { createOrdinaryBranchProject, ordinaryBranchTarget } from "./ordinary-branch-delivery.mjs";
import { refreshTaskOwners } from "./ownership.mjs";
import { pathsReferToSameLocation } from "./paths.mjs";
import { findProjectRegistry } from "./registry.mjs";
import { readCurrentBranch } from "./workspace-checks.mjs";

export async function inspectOrdinaryBranch({ cwd, home, intent }) {
  if (intent) return undefined;
  const [projectRoot, callerRoot] = await Promise.all([
    findMainProjectDirectory(cwd),
    findRepositoryRoot(cwd),
  ]);
  if (!projectRoot || !callerRoot || !await pathsReferToSameLocation(projectRoot, callerRoot)) return undefined;
  const registry = await findProjectRegistry({ home, projectRoot });
  const trunk = registry?.state.project.trunk ?? await resolveUnmanagedTrunk(projectRoot);
  const branch = await readCurrentBranch(projectRoot);
  if (branch === trunk) return undefined;
  const { stdout: status } = await runGit(projectRoot, ["status", "--short"]);
  return {
    kind: "ordinary-branch",
    projectRoot,
    callerRoot,
    registry,
    project: registry?.state.project ?? createOrdinaryBranchProject(projectRoot, trunk),
    slot: ordinaryBranchTarget(projectRoot, branch),
    status,
  };
}

export async function inspectDeliveryTask({ cwd, home, intent }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (!projectRoot) throw new Error("orchard deliver must run inside a Git repository");
  const registry = await findProjectRegistry({ home, projectRoot });
  if (!registry) throw new Error("This repository has no Orchard project group");
  const slot = await resolveTaskSlot(registry, cwd, intent);
  const [{ stdout: status }, callerRoot] = await Promise.all([
    runGit(slot.path, ["status", "--short"]),
    findRepositoryRoot(cwd),
  ]);
  return { projectRoot, callerRoot, registry, slot, status };
}

export async function assertNamedDeliveryUnoccupied({ home, projectRoot, intent }) {
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  await withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = await resolveTaskSlot(registry, projectRoot, intent);
    if (refreshTaskOwners(slot).length > 0) throw new Error(`Task worktree '${slot.intent}' is occupied`);
  });
}

export function createNeedsCommitOutcome(projectOrRegistry, slot, status) {
  const project = projectOrRegistry.state?.project ?? projectOrRegistry;
  return {
    project,
    worktree: slot.kind === "ordinary-branch"
      ? slot
      : { path: slot.path, intent: slot.intent, branch: slot.branch },
    commit: { status },
    delivery: { status: "needs-commit" },
    transition: { kind: "none", targetPath: slot.path },
  };
}

async function resolveUnmanagedTrunk(projectRoot) {
  const remoteTrunk = await findRemoteTrunk(projectRoot);
  if (remoteTrunk && await localBranchExists(projectRoot, remoteTrunk)) return remoteTrunk;
  const candidates = [];
  for (const branch of ["main", "master"]) {
    if (await localBranchExists(projectRoot, branch)) candidates.push(branch);
  }
  if (candidates.length === 1) return candidates[0];
  throw new Error("Orchard could not determine the trunk branch for this ordinary checkout");
}

async function localBranchExists(projectRoot, branch) {
  try {
    await runGit(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}
