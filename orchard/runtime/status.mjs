import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { findMainProjectDirectory } from "./git.mjs";

export async function readOrchardStatus({ home = process.env.HOME, cwd = process.cwd(), all = false } = {}) {
  if (!home) throw new Error("HOME is required");
  const groups = await readProjectGroups(path.join(home, ".orchard"));
  const projectRoot = all ? undefined : await findMainProjectDirectory(cwd);
  const projects = projectRoot
    ? groups.filter((group) => group.root === projectRoot)
    : groups;
  return { projects };
}

async function readProjectGroups(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const groups = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => readProjectState(root, entry.name)),
  );
  return groups.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name));
}

async function readProjectState(root, groupName) {
  try {
    const state = JSON.parse(await readFile(path.join(root, groupName, "state.json"), "utf8"));
    if (state?.project?.name !== groupName || typeof state.project.root !== "string") return undefined;
    const projectRoot = await realpath(state.project.root).catch(() => path.resolve(state.project.root));
    return { ...state.project, root: projectRoot, slots: Array.isArray(state.slots) ? state.slots : [] };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function formatOrchardStatus(status) {
  if (status.projects.length === 0) return "No Orchard projects.";
  return status.projects.map((project) => project.name).join("\n");
}
