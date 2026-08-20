import { queryGitHubPullRequests } from "./forge.mjs";
import { runGit } from "./git.mjs";

export async function proveLanding({
  projectRoot,
  featureBranch,
  featureTip,
  trunk,
  queryPullRequests = queryGitHubPullRequests,
}) {
  if (await isTipAncestorOfTrunk(projectRoot, featureTip, trunk)) {
    return { status: "landed", evidence: "ancestry" };
  }
  let pullRequests;
  try {
    pullRequests = await queryPullRequests({ projectRoot, featureBranch });
  } catch {
    return { status: "unverifiable", evidence: "forge-unavailable" };
  }
  if (!Array.isArray(pullRequests)) return { status: "unverifiable", evidence: "malformed-forge-response" };
  for (const pullRequest of pullRequests) {
    if (!matchesFeatureTip(pullRequest, featureTip)) continue;
    return { status: "landed", evidence: "github-pull-request", url: pullRequest.url };
  }
  return { status: "unverifiable", evidence: pullRequests.length ? "forge-mismatch" : "no-forge-evidence" };
}

function matchesFeatureTip(pullRequest, featureTip) {
  return pullRequest?.state === "MERGED"
    && pullRequest.headRefOid === featureTip
    && typeof pullRequest.mergeCommit?.oid === "string";
}

export async function isTipAncestorOfTrunk(projectRoot, feature, trunk) {
  try {
    await runGit(projectRoot, ["merge-base", "--is-ancestor", feature, trunk]);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}
