import { readGlobalAlias, runGit, runTrustedAlias } from "./git.mjs";
import { inspectDeliveryTask } from "./delivery-inspection.mjs";
import { rebaseTask } from "./rebase-service.mjs";
import { resolveTaskBaseBranch } from "./task-base.mjs";

const PULL_REQUEST_TIMEOUT_MS = 120_000;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/;

export async function deliverPullRequest({ cwd, home, intent }) {
  const inspection = await inspectDeliveryTask({ cwd, home, intent });
  const publication = await inspectPublication(inspection.slot.path, inspection.slot.branch);
  const baseBranch = await resolveTaskBaseBranch(inspection.registry, inspection.slot);
  const rebased = await rebaseTask({
    cwd,
    home,
    intent,
    baseBranch,
    preferredRemote: publication.remote,
  });
  const currentPublication = await inspectPublication(inspection.slot.path, inspection.slot.branch);
  assertPublicationUnchanged(publication, currentPublication);
  if (currentPublication.tip
    && !await isAncestor(inspection.slot.path, currentPublication.tip, rebased.rebase.tip)) {
    throw new Error(`Published tip ${currentPublication.tip} is not an ancestor of the rebased feature tip; choose how to publish the rewritten branch`);
  }
  const pullRequestAlias = await readGlobalAlias(inspection.slot.path, "pr");
  if (pullRequestAlias === undefined) throw new Error("Pull-request delivery requires a trusted global git pr alias");
  const finalPublication = await observePublication(inspection.slot.path, inspection.slot.branch);
  assertPublicationUnchanged(currentPublication, finalPublication);
  const pullRequestArguments = ["create", "--web", "--fill"];
  if (baseBranch !== inspection.registry.state.project.trunk) {
    pullRequestArguments.push("--base", baseBranch);
  }
  await runTrustedAlias(
    inspection.slot.path,
    "pr",
    pullRequestAlias,
    pullRequestArguments,
    { timeout: PULL_REQUEST_TIMEOUT_MS },
  );
  return {
    ...rebased,
    delivery: {
      status: "pr-form-opened",
      strategy: "pull-request",
      remote: publication.remote,
      baseBranch,
      publishedTip: publication.tip,
    },
  };
}

async function inspectPublication(worktreePath, branch) {
  const publication = await observePublication(worktreePath, branch);
  if (!publication.tip) return publication;
  await runGit(worktreePath, ["fetch", "--no-tags", publication.remote, publication.reference]);
  await runGit(worktreePath, ["cat-file", "-e", `${publication.tip}^{commit}`]);
  return publication;
}

async function observePublication(worktreePath, branch) {
  const [configuredRemote, configuredMerge, remotes] = await Promise.all([
    readOptionalConfig(worktreePath, `branch.${branch}.remote`),
    readOptionalConfig(worktreePath, `branch.${branch}.merge`),
    readRemotes(worktreePath),
  ]);
  if ((configuredRemote === undefined) !== (configuredMerge === undefined)) {
    throw new Error("Pull-request publication status is ambiguous because upstream configuration is incomplete");
  }
  const remote = resolveTargetRemote(configuredRemote, remotes);
  const references = new Set([`refs/heads/${branch}`]);
  if (configuredRemote === remote && configuredMerge?.startsWith("refs/heads/")) {
    references.add(configuredMerge);
  }
  const published = await readPublishedReferences(worktreePath, remote, references);
  const tips = new Set(published.map((entry) => entry.tip));
  if (tips.size > 1) throw new Error("Pull-request publication status is ambiguous across configured and same-named remote heads");
  const selected = published[0];
  if (!selected) return { remote, tip: undefined, reference: undefined };
  return { remote, tip: selected.tip, reference: selected.reference };
}

function assertPublicationUnchanged(expected, observed) {
  if (observed.remote !== expected.remote || observed.tip !== expected.tip) {
    throw new Error("Published branch changed during delivery; retry against current remote state");
  }
}

function resolveTargetRemote(configuredRemote, remotes) {
  if (configuredRemote === ".") throw new Error("A local upstream cannot be a pull-request target remote");
  if (configuredRemote) {
    if (!remotes.includes(configuredRemote)) throw new Error(`Configured upstream remote '${configuredRemote}' does not exist`);
    return configuredRemote;
  }
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0];
  throw new Error("Pull-request target remote is ambiguous");
}

async function readRemotes(worktreePath) {
  const { stdout } = await runGit(worktreePath, ["remote"]);
  return stdout ? stdout.split("\n").filter(Boolean) : [];
}

async function readPublishedReferences(worktreePath, remote, references) {
  const { stdout } = await runGit(worktreePath, ["ls-remote", "--heads", remote, ...references]);
  if (!stdout) return [];
  return stdout.split("\n").map((line) => parsePublishedReference(line, references));
}

function parsePublishedReference(line, expectedReferences) {
  const [tip, reference, extra] = line.split(/\s+/);
  if (extra || !OBJECT_ID_PATTERN.test(tip) || !expectedReferences.has(reference)) {
    throw new Error("Remote returned malformed pull-request branch metadata");
  }
  return { tip, reference };
}

async function readOptionalConfig(worktreePath, key) {
  try {
    const { stdout } = await runGit(worktreePath, ["config", "--get", key]);
    return stdout;
  } catch (error) {
    if (error?.code === 1) return undefined;
    throw error;
  }
}

async function isAncestor(worktreePath, ancestor, descendant) {
  try {
    await runGit(worktreePath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}
