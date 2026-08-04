import { readGlobalAlias, runGit, runTrustedAlias } from "./git.mjs";

export async function synchronizeTrunk(projectRoot, trunk) {
  if (!await hasConfiguredUpstream(projectRoot, trunk)) return;
  await runGit(projectRoot, ["fetch", "--all", "--prune"]);
  const upstream = await resolveConfiguredUpstream(projectRoot, trunk);
  const relation = await classifyRelation(projectRoot, trunk, upstream);
  if (relation === "diverged") throw new Error(`Trunk '${trunk}' has diverged from '${upstream}'`);

  if (relation !== "ahead") await synchronizeBehindOrEqual(projectRoot, upstream, relation);
  await runGit(projectRoot, ["submodule", "update", "--init", "--recursive"]);
  await verifySynchronizedTrunk(projectRoot, trunk, upstream);
}

async function hasConfiguredUpstream(projectRoot, trunk) {
  const [remote, mergeRef] = await Promise.all([
    readOptionalConfig(projectRoot, `branch.${trunk}.remote`),
    readOptionalConfig(projectRoot, `branch.${trunk}.merge`),
  ]);
  if (remote === undefined && mergeRef === undefined) return false;
  if (!remote || !mergeRef) throw new Error(`Trunk '${trunk}' has incomplete upstream configuration`);
  return true;
}

async function readOptionalConfig(projectRoot, key) {
  try {
    const { stdout } = await runGit(projectRoot, ["config", "--get", key]);
    return stdout;
  } catch (error) {
    if (error?.code === 1) return undefined;
    throw error;
  }
}

async function resolveConfiguredUpstream(projectRoot, trunk) {
  try {
    const { stdout } = await runGit(projectRoot, ["rev-parse", "--abbrev-ref", `${trunk}@{upstream}`]);
    return stdout;
  } catch (error) {
    throw new Error(`Trunk '${trunk}' has a configured upstream that could not be resolved after fetch`, { cause: error });
  }
}

async function synchronizeBehindOrEqual(projectRoot, upstream, relation) {
  const alias = await readGlobalAlias(projectRoot, "sync");
  if (alias !== undefined) {
    await runTrustedAlias(projectRoot, "sync", alias);
    return;
  }
  if (relation === "behind") await runGit(projectRoot, ["merge", "--ff-only", upstream]);
}

async function verifySynchronizedTrunk(projectRoot, trunk, upstream) {
  const { stdout: branch } = await runGit(projectRoot, ["branch", "--show-current"]);
  if (branch !== trunk) throw new Error(`Synchronization left trunk '${trunk}' for '${branch || "detached HEAD"}'`);
  const { stdout: status } = await runGit(projectRoot, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) throw new Error("Synchronization left the main project directory dirty");
  const relation = await classifyRelation(projectRoot, trunk, upstream);
  if (relation === "equal" || relation === "ahead") return;
  if (relation === "behind") throw new Error(`Synchronization left trunk '${trunk}' behind '${upstream}'`);
  throw new Error(`Trunk '${trunk}' has diverged from '${upstream}'`);
}

async function classifyRelation(projectRoot, trunk, upstream) {
  const upstreamIsAncestor = await isAncestor(projectRoot, upstream, trunk);
  const trunkIsAncestor = await isAncestor(projectRoot, trunk, upstream);
  if (upstreamIsAncestor && trunkIsAncestor) return "equal";
  if (upstreamIsAncestor) return "ahead";
  if (trunkIsAncestor) return "behind";
  return "diverged";
}

async function isAncestor(projectRoot, ancestor, descendant) {
  try {
    await runGit(projectRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}
