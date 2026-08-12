import { spawnSync } from "node:child_process";

// Harness Bash tools run commands through a transient `sh -c` shell. A claim
// recorded against that shell dies with it, so owner detection must walk past
// shells to the long-lived harness process (claude, bun, node, ...).
const SHELL_COMMAND_NAMES = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh"]);
const MAX_ANCESTOR_HOPS = 8;

export function findHarnessOwnerPid({ startPid = process.ppid, readProcessEntry = readProcessEntryFromPs } = {}) {
  let candidatePid = startPid;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    const entry = readProcessEntry(candidatePid);
    if (!entry) return startPid;
    if (!isShellCommand(entry.command)) return candidatePid;
    if (!Number.isSafeInteger(entry.parentPid) || entry.parentPid <= 1) return startPid;
    candidatePid = entry.parentPid;
  }
  return startPid;
}

function isShellCommand(command) {
  const executableName = String(command ?? "").split("/").pop().replace(/^-/, "").toLowerCase();
  return SHELL_COMMAND_NAMES.has(executableName);
}

function readProcessEntryFromPs(pid) {
  const psResult = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
  if (psResult.status !== 0) return null;
  const psLine = psResult.stdout.trim().match(/^(\d+)\s+(.+)$/);
  if (!psLine) return null;
  return { parentPid: Number(psLine[1]), command: psLine[2] };
}
