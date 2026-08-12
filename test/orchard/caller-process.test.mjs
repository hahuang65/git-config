import assert from "node:assert/strict";
import test from "node:test";

import { findHarnessOwnerPid } from "../../orchard/runtime/caller-process.mjs";

function readerFromTable(entriesByPid) {
  return (pid) => entriesByPid.get(pid) ?? null;
}

test("returns the start pid when its process is not a shell", () => {
  const readProcessEntry = readerFromTable(new Map([
    [500, { parentPid: 1, command: "claude" }],
  ]));
  assert.equal(findHarnessOwnerPid({ startPid: 500, readProcessEntry }), 500);
});

test("skips a transient shell parent and returns the harness ancestor", () => {
  const readProcessEntry = readerFromTable(new Map([
    [900, { parentPid: 500, command: "/bin/bash" }],
    [500, { parentPid: 1, command: "claude" }],
  ]));
  assert.equal(findHarnessOwnerPid({ startPid: 900, readProcessEntry }), 500);
});

test("skips chained shells including login-shell names", () => {
  const readProcessEntry = readerFromTable(new Map([
    [900, { parentPid: 800, command: "-bash" }],
    [800, { parentPid: 500, command: "/bin/zsh" }],
    [500, { parentPid: 1, command: "/usr/local/bin/bun" }],
  ]));
  assert.equal(findHarnessOwnerPid({ startPid: 900, readProcessEntry }), 500);
});

test("falls back to the start pid when process info is unreadable", () => {
  const readProcessEntry = readerFromTable(new Map());
  assert.equal(findHarnessOwnerPid({ startPid: 900, readProcessEntry }), 900);
});

test("falls back to the start pid when ancestry is shells all the way up", () => {
  const readProcessEntry = readerFromTable(new Map([
    [900, { parentPid: 1, command: "bash" }],
  ]));
  assert.equal(findHarnessOwnerPid({ startPid: 900, readProcessEntry }), 900);
});
