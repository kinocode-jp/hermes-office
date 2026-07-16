import assert from "node:assert/strict";
import test from "node:test";
import { MAX_OPEN_CHAT_SESSIONS, appendOpenSessionId } from "../src/store.ts";

test("opening a fifth chat evicts the oldest pane and keeps four", () => {
  const current = ["one", "two", "three", "four"];
  const next = appendOpenSessionId(current, "five");

  assert.equal(MAX_OPEN_CHAT_SESSIONS, 4);
  assert.deepEqual(next, ["two", "three", "four", "five"]);
  assert.deepEqual(current, ["one", "two", "three", "four"]);
});

test("reopening an existing chat does not reorder or duplicate it", () => {
  assert.deepEqual(appendOpenSessionId(["one", "two"], "one"), ["one", "two"]);
});
