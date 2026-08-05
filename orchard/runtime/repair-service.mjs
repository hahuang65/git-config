import path from "node:path";

import { proveBranchBinding } from "./branch-binding-verifier.mjs";
import { findMainProjectDirectory, findRepositoryRoot, runGit } from "./git.mjs";
import { assertNoInProgressGitOperation } from "./git-operation-state.mjs";
import { withProjectLock } from "./lock.mjs";
import { refreshTaskOwners } from "./ownership.mjs";
import { canonicalPath } from "./paths.mjs";
import { QUARANTINE_CODES } from "./quarantine.mjs";
import { findProjectRegistry, saveProjectState } from "./registry.mjs";

export async function repairTask({ cwd, home, intent }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  const callerRoot = await findRepositoryRoot(cwd);
  if (!projectRoot || !callerRoot) throw new Error("orchard repair must run inside a Git repository");
  const located = await findProjectRegistry({ home, projectRoot });
  if (!located) throw new Error("This repository has no Orchard project group");
  return withProjectLock(located.directory, async () => {
    const registry = await findProjectRegistry({ home, projectRoot });
    const slot = await selectQuarantinedSlot(registry, callerRoot, intent);
    const liveOwners = refreshTaskOwners(slot);
    if (liveOwners.length > 1) {
      throw new Error(`Task worktree '${slot.intent}' has multiple live owners`);
    }
    if (slot.recovery) throw new Error(`Task worktree '${slot.intent}' has unresolved recovery state`);
    if (slot.pendingCleanup) throw new Error(`Task worktree '${slot.intent}' has pending cleanup recovery`);
    if (slot.quarantine?.code !== QUARANTINE_CODES.branchMismatch) {
      throw new Error(`Task worktree '${slot.intent}' is not quarantined for a branch mismatch`);
    }
    await assertTaskPathRole(registry, slot);
    await assertProjectOwnsWorktree(registry, slot);
    await assertUniqueDurableRegistration(registry.state.slots, slot);
    await assertNoInProgressGitOperation(slot.path);
    const proof = await proveBranchBinding({ projectRoot, slot });
    const statusEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const { stdout: status } = await runGit(
      slot.path,
      ["status", "--porcelain", "--untracked-files=normal"],
      { env: statusEnvironment },
    );
    const priorQuarantine = slot.quarantine;
    const repairedAt = new Date().toISOString();
    Object.assign(slot, {
      lifecycle: "task",
      lastRepair: { ...priorQuarantine, repairedAt },
    });
    delete slot.quarantine;
    await saveProjectState(registry);
    return {
      project: registry.state.project,
      worktree: { path: slot.path, intent: slot.intent, branch: slot.branch },
      repair: {
        priorQuarantine,
        ...(priorQuarantine.observedBranch === null
          ? { previouslyDetachedHead: true }
          : { accidentalBranch: priorQuarantine.observedBranch }),
        dirty: Boolean(status),
        proof,
        repairedAt,
      },
    };
  });
}

async function assertTaskPathRole(registry, slot) {
  const expectedPath = path.join(registry.directory, slot.intent);
  if (await canonicalPath(slot.path) !== await canonicalPath(expectedPath)) {
    throw new Error(`Task path does not match worktree intent '${slot.intent}'`);
  }
}

async function assertProjectOwnsWorktree(registry, slot) {
  const worktreeProjectRoot = await findMainProjectDirectory(slot.path);
  if (worktreeProjectRoot
      && await canonicalPath(worktreeProjectRoot) !== await canonicalPath(registry.state.project.root)) {
    throw new Error(`Registered project does not own task worktree '${slot.intent}'`);
  }
}

async function assertUniqueDurableRegistration(slots, selected) {
  const selectedPath = await canonicalPath(selected.path);
  for (const slot of slots) {
    if (slot === selected) continue;
    if (await canonicalPath(slot.path) === selectedPath) {
      throw new Error(`Task worktree '${selected.intent}' has a duplicate durable path registration`);
    }
    if (selected.branch && slot.branch === selected.branch) {
      throw new Error(`Task worktree '${selected.intent}' has a duplicate durable branch registration`);
    }
  }
}

async function selectQuarantinedSlot(registry, callerRoot, intent) {
  const callerPath = await canonicalPath(callerRoot);
  const mainPath = await canonicalPath(registry.state.project.root);
  if (callerPath === mainPath) {
    if (!intent) throw new Error("Specify a quarantined worktree intent to repair");
    const slot = registry.state.slots.find((candidate) =>
      candidate.lifecycle === "quarantined" && candidate.intent === intent);
    if (!slot) throw new Error(`No quarantined worktree matches '${intent}'`);
    return slot;
  }
  for (const slot of registry.state.slots.filter((candidate) => candidate.lifecycle === "quarantined")) {
    if (await canonicalPath(slot.path) !== callerPath) continue;
    if (intent && intent !== slot.intent) throw new Error(`Quarantined worktree intent is '${slot.intent}'`);
    return slot;
  }
  throw new Error("orchard repair must run from the main project directory or exact quarantined worktree");
}
