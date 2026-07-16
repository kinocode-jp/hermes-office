import assert from "node:assert/strict";
import test from "node:test";
import { characterSheetPosition } from "../src/components/character-portrait.tsx";
import {
  avatarForProfile,
  isSafeImageDataUrl,
  profileAvatars,
  resetProfileAvatar,
  setCreatureAvatar,
  setCustomAvatar
} from "../src/avatar-preferences.ts";

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

test("normalizes known ids and gives unknown profiles a stable creature", () => {
  assert.equal(characterSheetPosition("  profile-epsilon ").index, 5);
  const first = characterSheetPosition("new-runtime-profile");
  assert.deepEqual(characterSheetPosition("new-runtime-profile"), first);
  assert.ok(first.index >= 0 && first.index < 12);
  assert.equal(characterSheetPosition("").index, 11);
});

test("stores a separate creature choice for each profile and can reset it", () => {
  profileAvatars.value = {};
  setCreatureAvatar("profile-a", 4);
  setCreatureAvatar("profile-b", 9);
  assert.deepEqual(avatarForProfile("profile-a"), { kind: "creature", index: 4 });
  assert.deepEqual(avatarForProfile("profile-b"), { kind: "creature", index: 9 });
  resetProfileAvatar("profile-a");
  assert.equal(profileAvatars.value["profile-a"], undefined);
});

test("validates image data URLs and reports unavailable durable storage", async () => {
  profileAvatars.value = {};
  const png = "data:image/png;base64,aGVsbG8=";
  assert.equal(isSafeImageDataUrl(png), true);
  assert.equal(await setCustomAvatar("profile-a", png), false);
  assert.equal(await setCustomAvatar("profile-a", "data:image/svg+xml,<svg onload=alert(1) />"), false);
  assert.equal(await setCustomAvatar("profile-a", "https://example.com/avatar.png"), false);
});
