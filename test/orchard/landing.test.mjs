import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { proveLanding } from "../../orchard/runtime/landing.mjs";

function git(cwd, args) {
  const output = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (output.status !== 0) throw new Error(output.stderr);
  return output.stdout.trim();
}

async function createLandedGraph() {
  const repository = await mkdtemp(path.join(tmpdir(), "orchard-landing-"));
  git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "README.md"), "base\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  git(repository, ["switch", "-c", "feature"]);
  await writeFile(path.join(repository, "feature.txt"), "feature\n");
  git(repository, ["add", "feature.txt"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"]);
  const featureTip = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "main"]);
  git(repository, ["merge", "--ff-only", "feature"]);
  return { repository, featureTip };
}

async function createSquashGraph() {
  const repository = await mkdtemp(path.join(tmpdir(), "orchard-landing-"));
  git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "README.md"), "base\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  git(repository, ["switch", "-c", "feature"]);
  await writeFile(path.join(repository, "feature.txt"), "feature\n");
  git(repository, ["add", "feature.txt"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"]);
  const featureTip = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "main"]);
  git(repository, ["merge", "--squash", "feature"]);
  git(repository, ["-c", "user.name=Orchard Test", "-c", "user.email=test@example.com", "commit", "-m", "squash feature"]);
  return { repository, featureTip, mergeCommit: git(repository, ["rev-parse", "HEAD"]) };
}

test("landing proof uses local ancestry without querying a forge", async () => {
  const { repository, featureTip } = await createLandedGraph();
  let forgeRequests = 0;

  const proof = await proveLanding({
    projectRoot: repository,
    featureBranch: "feature",
    featureTip,
    trunk: "main",
    queryPullRequests: async () => {
      forgeRequests += 1;
      return [];
    },
  });

  assert.deepEqual(proof, { status: "landed", evidence: "ancestry" });
  assert.equal(forgeRequests, 0);
});

test("matching merged pull-request metadata proves a squash landing", async () => {
  const { repository, featureTip, mergeCommit } = await createSquashGraph();

  const proof = await proveLanding({
    projectRoot: repository,
    featureBranch: "feature",
    featureTip,
    trunk: "main",
    queryPullRequests: async () => [{
      state: "MERGED",
      headRefOid: featureTip,
      mergeCommit: { oid: mergeCommit },
      url: "https://github.example/pull/1",
    }],
  });

  assert.deepEqual(proof, {
    status: "landed",
    evidence: "github-pull-request",
    url: "https://github.example/pull/1",
  });
});

test("an unavailable forge leaves non-ancestral landing unverifiable", async () => {
  const { repository, featureTip } = await createSquashGraph();

  const proof = await proveLanding({
    projectRoot: repository,
    featureBranch: "feature",
    featureTip,
    trunk: "main",
    queryPullRequests: async () => { throw new Error("offline"); },
  });

  assert.deepEqual(proof, { status: "unverifiable", evidence: "forge-unavailable" });
});

test("malformed forge metadata remains unverifiable", async () => {
  const { repository, featureTip } = await createSquashGraph();

  const proof = await proveLanding({
    projectRoot: repository,
    featureBranch: "feature",
    featureTip,
    trunk: "main",
    queryPullRequests: async () => ({ state: "MERGED" }),
  });

  assert.deepEqual(proof, { status: "unverifiable", evidence: "malformed-forge-response" });
});

test("closed pull-request metadata cannot prove landing", async () => {
  const { repository, featureTip, mergeCommit } = await createSquashGraph();

  const proof = await proveLanding({
    projectRoot: repository,
    featureBranch: "feature",
    featureTip,
    trunk: "main",
    queryPullRequests: async () => [{
      state: "CLOSED",
      headRefOid: featureTip,
      mergeCommit: { oid: mergeCommit },
      url: "https://github.example/pull/2",
    }],
  });

  assert.deepEqual(proof, { status: "unverifiable", evidence: "forge-mismatch" });
});
