import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { withProjectLock } from "../../orchard/runtime/lock.mjs";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("project lock serializes concurrent mutations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orchard-lock-"));
  let active = 0;
  let maximumActive = 0;
  const mutation = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await sleep(60);
    active -= 1;
  };

  await Promise.all([
    withProjectLock(directory, mutation),
    withProjectLock(directory, mutation),
  ]);

  assert.equal(maximumActive, 1);
});
