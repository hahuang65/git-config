import assert from "node:assert/strict";
import test from "node:test";

import { readTreehouseCapacity } from "../../treehouse/runtime/capacity.mjs";

test("capacity defaults to four", () => {
  assert.equal(readTreehouseCapacity(undefined), 4);
});
