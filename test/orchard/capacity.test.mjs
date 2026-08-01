import assert from "node:assert/strict";
import test from "node:test";

import { readOrchardCapacity } from "../../orchard/runtime/capacity.mjs";

test("capacity defaults to four", () => {
  assert.equal(readOrchardCapacity(undefined), 4);
});
