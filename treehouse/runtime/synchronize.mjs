import { readGlobalAlias, runGit, runTrustedAlias } from "./git.mjs";

export async function synchronizeTrunk(projectRoot, trunk) {
  const alias = await readGlobalAlias(projectRoot, "sync");
  if (alias === undefined) await synchronizeExplicitly(projectRoot, trunk);
  else await runTrustedAlias(projectRoot, "sync", alias);
  await verifySynchronizedTrunk(projectRoot, trunk);
}

async function synchronizeExplicitly(projectRoot, trunk) {
  await runGit(projectRoot, ["fetch", "--all", "--prune"]);
  const upstream = await findUpstream(projectRoot, trunk);
  await runGit(projectRoot, ["merge", "--ff-only", upstream]);
  await runGit(projectRoot, ["submodule", "update", "--init", "--recursive"]);
}

async function verifySynchronizedTrunk(projectRoot, trunk) {
  const upstream = await findUpstream(projectRoot, trunk);
  const { stdout: branch } = await runGit(projectRoot, ["branch", "--show-current"]);
  if (branch !== trunk) throw new Error(`Synchronization left trunk '${trunk}' for '${branch || "detached HEAD"}'`);
  const { stdout: status } = await runGit(projectRoot, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) throw new Error("Synchronization left the main project directory dirty");
  const { stdout: localTip } = await runGit(projectRoot, ["rev-parse", trunk]);
  const { stdout: upstreamTip } = await runGit(projectRoot, ["rev-parse", upstream]);
  if (localTip !== upstreamTip) throw new Error(`Synchronization did not align '${trunk}' with '${upstream}'`);
}

async function findUpstream(projectRoot, trunk) {
  const { stdout } = await runGit(projectRoot, ["rev-parse", "--abbrev-ref", `${trunk}@{upstream}`]);
  return stdout;
}
