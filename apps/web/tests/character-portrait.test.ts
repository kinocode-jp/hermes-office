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

test("maps neutral profile ids to stable character-sheet cells", () => {
  for (const profileId of ["profile-alpha", "profile-beta", "profile-gamma", "profile-delta", "profile-epsilon", "profile-zeta", "profile-eta"]) {
    const first = characterSheetPosition(profileId);
    assert.deepEqual(characterSheetPosition(`  ${profileId.toUpperCase()}  `), first);
    assert.equal(first.column, 0);
    assert.ok(first.row >= 0 && first.row < 6);
  }
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
