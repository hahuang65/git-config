import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSuccessfulRepair,
  createQuarantinedTask,
  createRepository,
  git,
  runOrchard,
  snapshotGitState,
} from "./repair-helpers.mjs";

test("repair selects a quarantined worktree by intent from the main project directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);

  const output = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout).worktree, task);
});

test("repair proves a worktree path containing a newline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const home = path.join(root, "home\nwith-newline");
  await mkdir(home);
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);

  const output = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).worktree.path, task.path);
});

test("repair requires intent from the main project directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  await createQuarantinedTask(repository, home);

  const output = await runOrchard(repository, home, ["repair", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /Specify a quarantined worktree intent/);
});

test("repair help documents location, dirty-work, and non-deletion guarantees", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));

  const output = await runOrchard(home, home, ["repair", "--help"]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /exact quarantined worktree|main project directory/i);
  assert.match(output.stdout, /dirty task files are preserved/i);
  assert.match(output.stdout, /never deletes.*accidental branch/i);
  assert.match(output.stdout, /multiple live owners/i);
  assert.match(output.stdout, /merge.*rebase.*cherry-pick.*revert.*bisect/i);
});

test("repair rejects a mismatched intent from the quarantined worktree", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  const output = await runOrchard(task.path, home, ["repair", "another-task", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, new RegExp(`intent is '${task.intent}'`));
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair completion lists eligible branch-mismatch quarantines", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);

  const output = await runOrchard(repository, home, ["__complete", "repair"]);

  assert.deepEqual(output, { stdout: `${task.intent}\n`, stderr: "", exitCode: 0 });
});

test("repair human output reports verified and preserved state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);

  const output = await runOrchard(repository, home, ["repair", task.intent]);

  assert.deepEqual(output, {
    stdout: `Repaired ${task.intent} (${task.path}) [${task.branch}]; left Git unchanged (previously observed branch 'accidental-branch'); dirty worktree: no\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("repair human output describes previously detached HEAD without a null branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const created = await runOrchard(repository, home, ["new", "Detached Repair", "--offline", "--json"]);
  assert.equal(created.exitCode, 0, created.stderr);
  const task = JSON.parse(created.stdout).worktree;
  git(task.path, ["switch", "--detach"]);
  const quarantined = await runOrchard(repository, home, ["status", "--refresh", "--json"]);
  assert.equal(quarantined.exitCode, 0, quarantined.stderr);
  git(task.path, ["switch", task.branch]);

  const output = await runOrchard(repository, home, ["repair", task.intent]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /previously observed detached HEAD/);
  assert.doesNotMatch(output.stdout, /branch 'null'/);
});

test("repair fails unchanged after the slot is restored", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const first = await runOrchard(repository, home, ["repair", task.intent, "--json"]);
  assert.equal(first.exitCode, 0, first.stderr);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const stateAfterFirst = await readFile(statePath, "utf8");

  const second = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.equal(second.exitCode, 1);
  assert.match(second.stderr, /No quarantined worktree matches/);
  assert.equal(await readFile(statePath, "utf8"), stateAfterFirst);
});

test("repair leaves structured non-branch quarantine ineligible", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].quarantine.code = "missing-worktree-metadata";
  await writeFile(statePath, JSON.stringify(state));
  const before = await readFile(statePath, "utf8");

  const output = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /not quarantined for a branch mismatch/);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair leaves legacy unstructured quarantine ineligible", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].quarantine = { reason: "Registered branch mismatch" };
  await writeFile(statePath, JSON.stringify(state));
  const before = await readFile(statePath, "utf8");

  const output = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /not quarantined for a branch mismatch/);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects another linked worktree as a caller", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const linked = path.join(home, "linked", "other");
  git(repository, ["worktree", "add", "--detach", linked, "main"]);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  const output = await runOrchard(linked, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /main project directory or exact quarantined worktree/);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects a registered project that does not own the task worktree", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const otherRepository = path.join(home, "projects", "beta");
  git(home, ["init", "--initial-branch=main", otherRepository]);
  await writeFile(path.join(otherRepository, "README.md"), "beta\n");
  git(otherRepository, ["add", "README.md"]);
  git(otherRepository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.project.root = await realpath(otherRepository);
  await writeFile(statePath, JSON.stringify(state));
  const before = await readFile(statePath, "utf8");

  const output = await runOrchard(otherRepository, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /registered project does not own.*task worktree/i);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair distinguishes the wrong checked-out branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  git(task.path, ["switch", "accidental-branch"]);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  const output = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, new RegExp(`expected branch '${task.branch}'.*observed 'accidental-branch'`));
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair distinguishes detached HEAD from a wrong branch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  git(task.path, ["switch", "--detach"]);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  const output = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /observed 'detached HEAD'/);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair distinguishes missing Git path metadata", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  git(repository, ["worktree", "remove", "--force", task.path]);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  const output = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /registered path is missing from Git worktree metadata/i);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair distinguishes duplicate Git branch metadata", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const duplicate = path.join(home, "linked", "duplicate");
  git(repository, ["worktree", "add", "--force", duplicate, task.branch]);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const before = await readFile(statePath, "utf8");

  const output = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /duplicate Git branch metadata/i);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("repair rejects a task path that does not match its intent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots[0].intent = "wrong-intent";
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(path.join(task.path, "untracked.txt"), "preserve me\n");
  const before = await readFile(statePath, "utf8");
  const gitBefore = await snapshotGitState(repository, task.path);

  const output = await runOrchard(repository, home, ["repair", "wrong-intent", "--json"]);

  assert.equal(output.exitCode, 1);
  assert.match(output.stderr, /task path does not match.*intent/i);
  assert.equal(await readFile(statePath, "utf8"), before);
  assert.deepEqual(await snapshotGitState(repository, task.path), gitBefore);
});

test("repair rejects duplicate durable registrations without changing state or Git", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { task } = await createQuarantinedTask(repository, home);
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.slots.push({
    ...state.slots[0],
    id: "duplicate-durable-registration",
    intent: "duplicate-repair",
  });
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(path.join(task.path, "untracked.txt"), "preserve me\n");
  const stateBefore = await readFile(statePath, "utf8");
  const gitBefore = await snapshotGitState(repository, task.path);

  const output = await runOrchard(repository, home, ["repair", task.intent, "--json"]);

  assert.deepEqual({
    exitCode: output.exitCode,
    stdout: output.stdout,
    rejectedAsDuplicate: /duplicate durable (path|branch) registration/i.test(output.stderr),
    state: await readFile(statePath, "utf8"),
    git: await snapshotGitState(repository, task.path),
  }, {
    exitCode: 1,
    stdout: "",
    rejectedAsDuplicate: true,
    state: stateBefore,
    git: gitBefore,
  });
});

test("repair restores a proven dirty task worktree without changing Git state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orchard-repair-"));
  const repository = await createRepository(home);
  const { priorQuarantine, task } = await createQuarantinedTask(repository, home);
  await writeFile(path.join(task.path, "README.md"), "staged\n");
  git(task.path, ["add", "README.md"]);
  await appendFile(path.join(task.path, "README.md"), "unstaged\n");
  await writeFile(path.join(task.path, "untracked.txt"), "untracked\n");
  const expectedCommit = git(task.path, ["rev-parse", "HEAD"]);
  const expectedCanonicalPath = await realpath(task.path);
  const gitBefore = await snapshotGitState(repository, task.path);

  const output = await runOrchard(task.path, home, ["repair", "--json"]);

  assert.equal(output.exitCode, 0, output.stderr);
  const repairedAt = assertSuccessfulRepair({
    outcome: JSON.parse(output.stdout),
    task,
    priorQuarantine,
    expectedCanonicalPath,
    expectedCommit,
  });
  const statePath = path.join(home, ".orchard", "alpha", "state.json");
  const repairedSlot = JSON.parse(await readFile(statePath, "utf8")).slots[0];
  assert.deepEqual({
    lifecycle: repairedSlot.lifecycle,
    hasActiveQuarantine: Object.hasOwn(repairedSlot, "quarantine"),
    lastRepair: repairedSlot.lastRepair,
  }, {
    lifecycle: "task",
    hasActiveQuarantine: false,
    lastRepair: { ...priorQuarantine, repairedAt },
  });
  assert.deepEqual(await snapshotGitState(repository, task.path), gitBefore);
});
