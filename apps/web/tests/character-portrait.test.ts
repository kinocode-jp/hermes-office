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
  ["profile-alpha", 1, 0, 1, "0% 20%"],
  ["profile-beta", 2, 0, 2, "0% 40%"],
  ["profile-gamma", 3, 0, 3, "0% 60%"],
  ["profile-delta", 4, 0, 4, "0% 80%"],
  ["profile-epsilon", 5, 0, 5, "0% 100%"],
  ["profile-zeta", 0, 0, 0, "0% 0%"],
  ["profile-eta", 1, 0, 1, "0% 20%"],
  ["profile-kappa", 2, 0, 2, "0% 40%"],
  ["profile-theta", 3, 0, 3, "0% 60%"],
  ["profile-iota", 4, 0, 4, "0% 80%"]
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
  assert.ok(first.index >= 0 && first.index < 6);
  assert.equal(characterSheetPosition("").index, 5);
});

test("stores a separate creature choice for each profile and can reset it", () => {
  profileAvatars.value = {};
  setCreatureAvatar("profile-a", 4);
  setCreatureAvatar("profile-b", 2);
  assert.deepEqual(avatarForProfile("profile-a"), { kind: "creature", index: 4 });
  assert.deepEqual(avatarForProfile("profile-b"), { kind: "creature", index: 2 });
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
