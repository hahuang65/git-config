import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeIntent } from "./intent.mjs";

const STATE_VERSION = 1;

export async function openProjectRegistry({ home, projectRoot, trunk }) {
  const orchardRoot = path.join(home, ".orchard");
  await mkdir(orchardRoot, { recursive: true });
  const name = await resolveProjectName(orchardRoot, projectRoot);
  const directory = path.join(orchardRoot, name);
  await mkdir(directory, { recursive: true });
  const statePath = path.join(directory, "state.json");
  const state = await readState(statePath) ?? {
    version: STATE_VERSION,
    project: { name, root: projectRoot, trunk },
    slots: [],
  };
  return { directory, statePath, state };
}

export async function findProjectRegistry({ home, projectRoot }) {
  const orchardRoot = path.join(home, ".orchard");
  let entries;
  try {
    entries = await readdir(orchardRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const directory = path.join(orchardRoot, entry.name);
    const statePath = path.join(directory, "state.json");
    const state = await readState(statePath);
    if (!state?.project?.root) continue;
    const registeredRoot = await realpath(state.project.root).catch(() => path.resolve(state.project.root));
    if (registeredRoot === projectRoot) return { directory, statePath, state };
  }
  return undefined;
}

export async function saveProjectState(registry) {
  const temporaryPath = `${registry.statePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(registry.state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, registry.statePath);
}

async function resolveProjectName(orchardRoot, projectRoot) {
  const basename = normalizeIntent(path.basename(projectRoot));
  if (await nameBelongsTo(orchardRoot, basename, projectRoot)) return basename;
  const parent = normalizeIntent(path.basename(path.dirname(projectRoot)));
  const qualified = `${parent}-${basename}`;
  if (await nameBelongsTo(orchardRoot, qualified, projectRoot)) return qualified;
  const suffix = createHash("sha256").update(projectRoot).digest("hex").slice(0, 8);
  return `${qualified}-${suffix}`;
}

async function nameBelongsTo(orchardRoot, name, projectRoot) {
  const state = await readState(path.join(orchardRoot, name, "state.json"));
  return !state || state?.project?.root === projectRoot;
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
