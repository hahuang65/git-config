import { readFile } from "node:fs/promises";
import path from "node:path";

import { findMainProjectDirectory } from "./git.mjs";
import { findProjectRegistry } from "./registry.mjs";

export async function locateProjectRegistry({ cwd, home, projectName }) {
  const projectRoot = await findMainProjectDirectory(cwd);
  if (projectRoot) {
    const registry = await findProjectRegistry({ home, projectRoot });
    if (registry) return registry;
  }
  if (!projectName) throw new Error("Specify a Orchard project group outside a Git repository");
  const directory = path.join(home, ".orchard", projectName);
  const statePath = path.join(directory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  return { directory, statePath, state };
}
