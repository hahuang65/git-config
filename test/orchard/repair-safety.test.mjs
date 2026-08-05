import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { repairTask } from "../../orchard/runtime/repair-service.mjs";
import { createQuarantinedTask, createRepository, git } from "./repair-helpers.mjs";

test("repair does not refresh raw index metadata", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const indexPath = git(task.path, ["rev-parse", "--git-path", "index"]);
  const before = await readFile(indexPath);
  const future = new Date(Date.now() + 60_000);
  await utimes(path.join(task.path, "README.md"), future, future);

  await repairTask({ cwd: repository, home, intent: task.intent });

  assert.deepEqual(await readFile(indexPath), before);
});

test("repair rejects an in-progress merge without changing quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const mergeHead = git(task.path, ["rev-parse", "--git-path", "MERGE_HEAD"]);
  await writeFile(mergeHead, `${git(task.path, ["rev-parse", "HEAD"])}\n`);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  await assert.rejects(
    repairTask({ cwd: repository, home, intent: task.intent }),
    /in-progress merge/,
  );
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects an in-progress rebase without changing quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const rebaseState = git(task.path, ["rev-parse", "--git-path", "rebase-merge"]);
  await mkdir(rebaseState);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  await assert.rejects(
    repairTask({ cwd: repository, home, intent: task.intent }),
    /in-progress rebase/,
  );
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects an apply-style rebase without changing quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const rebaseState = git(task.path, ["rev-parse", "--git-path", "rebase-apply"]);
  await mkdir(rebaseState);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  await assert.rejects(
    repairTask({ cwd: repository, home, intent: task.intent }),
    /in-progress rebase/,
  );
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects an in-progress cherry-pick without changing quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const marker = git(task.path, ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]);
  await writeFile(marker, `${git(task.path, ["rev-parse", "HEAD"])}\n`);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  await assert.rejects(
    repairTask({ cwd: repository, home, intent: task.intent }),
    /in-progress cherry-pick/,
  );
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects an in-progress revert without changing quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const marker = git(task.path, ["rev-parse", "--git-path", "REVERT_HEAD"]);
  await writeFile(marker, `${git(task.path, ["rev-parse", "HEAD"])}\n`);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  await assert.rejects(
    repairTask({ cwd: repository, home, intent: task.intent }),
    /in-progress revert/,
  );
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects an in-progress bisect without changing quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const marker = git(task.path, ["rev-parse", "--git-path", "BISECT_START"]);
  await writeFile(marker, `${task.branch}\n`);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  await assert.rejects(
    repairTask({ cwd: repository, home, intent: task.intent }),
    /in-progress bisect/,
  );
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects unresolved conversion recovery without changing quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].recovery = { kind: "conversion", status: "restoring" };
  await writeFile(statePath, JSON.stringify(state));
  const before = await readFile(statePath, "utf8");

  await assert.rejects(
    repairTask({ cwd: repository, home, intent: task.intent }),
    /unresolved recovery state/,
  );
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects pending cleanup recovery without changing quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].pendingCleanup = { operationId: "cleanup-operation" };
  await writeFile(statePath, JSON.stringify(state));
  const before = await readFile(statePath, "utf8");

  await assert.rejects(
    repairTask({ cwd: repository, home, intent: task.intent }),
    /pending cleanup recovery/,
  );
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("concurrent repairs serialize so only one restores the task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);

  const outcomes = await Promise.allSettled([
    repairTask({ cwd: repository, home, intent: task.intent }),
    repairTask({ cwd: repository, home, intent: task.intent }),
  ]);

  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
  const state = JSON.parse(await readFile(path.join(home, ".orchard", "alpha", "state.json"), "utf8"));
  assert.equal(state.slots[0].lifecycle, "task");
  assert.ok(state.slots[0].lastRepair);
});

test("repair rejects multiple live owners without changing quarantine", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].owners = [
    { token: "first", pid: process.pid, shared: true },
    { token: "second", pid: process.ppid, shared: true },
  ];
  await writeFile(statePath, JSON.stringify(state));
  const before = await readFile(statePath, "utf8");

  await assert.rejects(
    repairTask({ cwd: repository, home, intent: task.intent }),
    /multiple live owners/,
  );
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair discards dead owner claims and preserves one live owner", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const finished = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = finished.pid;
  await new Promise((resolve) => finished.on("close", resolve));
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const liveOwner = {
    token: "live-owner",
    pid: process.pid,
    shared: false,
    claimedAt: "2026-01-01T00:00:00.000Z",
  };
  state.slots[0].owners = [
    liveOwner,
    { ...liveOwner, token: "dead-owner", pid: deadPid },
  ];
  await writeFile(statePath, JSON.stringify(state));

  await repairTask({ cwd: repository, home, intent: task.intent });

  const repaired = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(repaired.slots[0].owners, [liveOwner]);
});
