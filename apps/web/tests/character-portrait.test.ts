import assert from "node:assert/strict";
import test from "node:test";
import { characterSheetPosition } from "../src/components/character-portrait.tsx";

const expectedCells = [
  ["default", 0, 0, 0, "0% 0%"],
  ["profile-alpha", 1, 1, 0, "33.3333% 0%"],
  ["profile-beta", 2, 2, 0, "66.6667% 0%"],
  ["profile-gamma", 3, 3, 0, "100% 0%"],
  ["profile-delta", 4, 0, 1, "0% 50%"],
  ["profile-epsilon", 5, 1, 1, "33.3333% 50%"],
  ["profile-zeta", 6, 2, 1, "66.6667% 50%"],
  ["profile-eta", 7, 3, 1, "100% 50%"],
  ["profile-kappa", 8, 0, 2, "0% 100%"],
  ["profile-theta", 9, 1, 2, "33.3333% 100%"],
  ["profile-iota", 10, 2, 2, "66.6667% 100%"]
] as const;

test("maps every known Hermes profile to its exact character-sheet cell", () => {
  for (const [profileId, index, column, row, backgroundPosition] of expectedCells) {
    assert.deepEqual(characterSheetPosition(profileId), { index, column, row, backgroundPosition });
  }
});

test("normalizes known ids and reserves the final cell for unknown profiles", () => {
  assert.equal(characterSheetPosition("  profile-epsilon ").index, 5);
  assert.deepEqual(characterSheetPosition("new-runtime-profile"), {
    index: 11,
    column: 3,
    row: 2,
    backgroundPosition: "100% 100%"
  });
  assert.equal(characterSheetPosition("").index, 11);
});
