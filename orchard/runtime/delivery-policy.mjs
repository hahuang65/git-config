import { runGit } from "./git.mjs";

const A5_PROJECT_FAMILY = "a5";
const DEFAULT_STRATEGY = "local";
const TRUSTED_SCOPES = new Set(["global", "system"]);
const STRATEGIES = new Set([DEFAULT_STRATEGY, "pull-request"]);

export async function readDeliveryStrategy(projectRoot) {
  if (await readTrustedProjectFamily(projectRoot) === A5_PROJECT_FAMILY) return "pull-request";
  let configured;
  try {
    ({ stdout: configured } = await runGit(projectRoot, [
      "config",
      "--show-scope",
      "--get",
      "orchard.deliveryStrategy",
    ]));
  } catch (error) {
    if (error?.code === 1) return DEFAULT_STRATEGY;
    throw error;
  }

  const separator = configured.indexOf("\t");
  if (separator < 1) throw new Error("Orchard delivery strategy has malformed Git configuration");
  const scope = configured.slice(0, separator);
  const strategy = configured.slice(separator + 1);
  if (!TRUSTED_SCOPES.has(scope)) {
    throw new Error("Orchard delivery strategy must come from trusted user or system Git configuration");
  }
  if (!STRATEGIES.has(strategy)) {
    throw new Error(`Unsupported Orchard delivery strategy '${strategy}'`);
  }
  return strategy;
}

async function readTrustedProjectFamily(projectRoot) {
  let configured;
  try {
    ({ stdout: configured } = await runGit(projectRoot, [
      "config",
      "--show-scope",
      "--get",
      "ai.projectFamily",
    ]));
  } catch (error) {
    if (error?.code === 1) return undefined;
    throw error;
  }
  const separator = configured.indexOf("\t");
  if (separator < 1) throw new Error("AI project family has malformed Git configuration");
  const scope = configured.slice(0, separator);
  return TRUSTED_SCOPES.has(scope) ? configured.slice(separator + 1) : undefined;
}
