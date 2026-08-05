import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { findMainProjectDirectory } from "./git.mjs";

const STATUS_SCOPE = Object.freeze({ GLOBAL: "global", PROJECT: "project" });
const ANSI = Object.freeze({
  reset: "\u001b[0m",
  projectName: "\u001b[1;36m",
  worktreeName: "\u001b[1;32m",
  quarantineName: "\u001b[1;33m",
});

export async function readOrchardStatus({ home = process.env.HOME, cwd = process.cwd(), all = false } = {}) {
  if (!home) throw new Error("HOME is required");
  const groups = await readProjectGroups(path.join(home, ".orchard"));
  const projectRoot = all ? undefined : await findMainProjectDirectory(cwd);
  const projects = projectRoot
    ? groups.filter((group) => group.root === projectRoot)
    : groups;
  return { projects, scope: projectRoot ? STATUS_SCOPE.PROJECT : STATUS_SCOPE.GLOBAL };
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

export function formatOrchardStatus(status, { color = false } = {}) {
  if (status.scope === STATUS_SCOPE.PROJECT) return formatScopedStatus(status.projects, color);
  if (status.projects.length === 0) return "No Orchard projects.";
  return status.projects.map((project) => formatProjectStatus(project, color)).join("\n");
}

export function shouldUseColor(stream = process.stdout, environment = process.env) {
  if (Object.hasOwn(environment, "NO_COLOR")) return false;
  if (Object.hasOwn(environment, "FORCE_COLOR")) return environment.FORCE_COLOR !== "0";
  return Boolean(stream.isTTY);
}

function formatScopedStatus(projects, color) {
  const activeWorktrees = projects.flatMap(findActiveWorktrees);
  if (activeWorktrees.length === 0) return "No active worktrees.";
  return activeWorktrees.map((worktree) => formatActiveWorktree(worktree, color)).join("\n");
}

function formatProjectStatus(project, color) {
  const heading = applyColor(project.name, ANSI.projectName, color);
  const activeWorktrees = findActiveWorktrees(project);
  if (activeWorktrees.length === 0) return `${heading}\n\tNo active worktrees.`;
  const worktreeLines = activeWorktrees.map((worktree) => `\t${formatActiveWorktree(worktree, color)}`);
  return [heading, ...worktreeLines].join("\n");
}

function findActiveWorktrees(project) {
  return project.slots.filter((slot) => ["task", "quarantined"].includes(slot.lifecycle));
}

function formatActiveWorktree(worktree, color) {
  if (worktree.lifecycle === "quarantined") return formatQuarantinedWorktree(worktree, color);
  const name = applyColor(worktree.intent, ANSI.worktreeName, color);
  return `${name} (${worktree.path}) [${worktree.branch}]`;
}

function formatQuarantinedWorktree(worktree, color) {
  const name = applyColor(worktree.intent ?? "unknown", ANSI.quarantineName, color);
  const evidence = worktree.quarantine ?? {};
  const binding = formatBindingEvidence(evidence);
  const reason = evidence.reason ?? "Quarantine reason unavailable";
  const detectedAt = evidence.detectedAt ? ` (${evidence.detectedAt})` : "";
  return `${name} (${worktree.path})${binding} QUARANTINED: ${reason}${detectedAt}`;
}

function formatBindingEvidence(evidence) {
  const hasExpected = Object.hasOwn(evidence, "expectedBranch");
  const hasObserved = Object.hasOwn(evidence, "observedBranch");
  if (!hasExpected && !hasObserved) return "";
  const expected = hasExpected ? evidence.expectedBranch : "unknown";
  const observed = evidence.observedBranch ?? "detached HEAD";
  return ` [expected: ${expected}; observed: ${observed}]`;
}

function applyColor(value, ansiColor, enabled) {
  return enabled ? `${ansiColor}${value}${ANSI.reset}` : value;
}
