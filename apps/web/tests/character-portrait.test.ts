import assert from "node:assert/strict";
import test from "node:test";
import { characterHueRotation, characterSheetPosition } from "../src/components/character-portrait.tsx";
import {
  AvatarOrdinalPreferences,
  avatarForProfile,
  isSafeImageDataUrl,
  profileAvatars,
  registerDefaultAvatarProfiles,
  resetProfileAvatar,
  setCreatureAvatar,
  setCustomAvatar
} from "../src/avatar-preferences.ts";

test("maps neutral profile ids to stable character-sheet cells", () => {
  const baseProfiles = ["profile-alpha", "profile-beta", "profile-gamma", "profile-delta", "profile-epsilon", "profile-zeta"];
  registerDefaultAvatarProfiles(baseProfiles);
  for (const profileId of baseProfiles) {
    const first = characterSheetPosition(profileId);
    assert.deepEqual(characterSheetPosition(`  ${profileId}  `), first);
    assert.equal(first.column, 0);
    assert.ok(first.row >= 0 && first.row < 6);
  }
  assert.deepEqual(baseProfiles.map(characterHueRotation), [0, 0, 0, 0, 0, 0]);
  assert.equal(characterHueRotation("profile-eta"), 53);
  const first = characterSheetPosition("new-runtime-profile");
  assert.deepEqual(characterSheetPosition("new-runtime-profile"), first);
  assert.ok(first.index >= 0 && first.index < 6);
  assert.equal(characterSheetPosition("").index, 5);
});

test("inventory reorder and insertion never change an existing profile's default character or color", () => {
  const saved: Record<string, number> = {};
  const assignments = new AvatarOrdinalPreferences({}, (next) => Object.assign(saved, next));
  const initial = Array.from({ length: 12 }, (_, index) => `stable-profile-${index}`);
  assignments.register(initial);
  const appearance = (profileId: string) => {
    const ordinal = assignments.ordinal(profileId);
    return { character: ordinal % 6, hue: (Math.floor(ordinal / 6) * 53) % 360 };
  };
  assert.deepEqual(initial.slice(0, 6).map((profileId) => appearance(profileId).hue), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(initial.slice(6).map((profileId) => appearance(profileId).hue), [53, 53, 53, 53, 53, 53]);
  const before = new Map(initial.map((profileId) => [profileId, appearance(profileId)]));
  const reorderedWithInsertions = ["new-leading-profile", ...[...initial].reverse(), "new-trailing-profile"];
  assignments.register(reorderedWithInsertions);
  for (const profileId of reorderedWithInsertions.filter((id) => before.has(id))) {
    assert.deepEqual(appearance(profileId), before.get(profileId));
  }
  assert.equal(appearance("new-leading-profile").hue, 106);
  assert.equal(saved["stable-profile-0"], 0);
});

test("authoritative reconciliation removes deleted slots and compacts the current roster", () => {
  const saved: Record<string, number> = Object.create(null);
  const assignments = new AvatarOrdinalPreferences({}, (next) => Object.assign(saved, next));
  const initial = Array.from({ length: 12 }, (_, index) => `profile-${index}`);
  assignments.register(initial);

  const remaining = initial.slice(6).reverse();
  assignments.reconcile(remaining);
  assert.deepEqual(initial.slice(6).map((profileId) => assignments.ordinal(profileId)), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(initial.slice(6).map((profileId) => Math.floor(assignments.ordinal(profileId) / 6) * 53), [0, 0, 0, 0, 0, 0]);

  assignments.reconcile(["new-leading", ...remaining]);
  assert.equal(assignments.ordinal("new-leading"), 6, "new IDs append after retained relative order");
  assert.equal(assignments.ordinal("profile-0"), 7, "a deleted ID is absent until it is observed again");
});

test("prototype-named Hermes Profiles receive distinct safe ordinal slots", () => {
  const persisted: Record<string, number>[] = [];
  const initial = Object.fromEntries([["constructor", 7], ["toString", 2], ["__proto__", 9]]);
  const assignments = new AvatarOrdinalPreferences(initial, (next) => persisted.push(next));
  assert.deepEqual(["toString", "constructor", "__proto__"].map((id) => assignments.ordinal(id)), [0, 1, 2]);
  assignments.register(["hasOwnProperty"]);
  assert.equal(assignments.ordinal("hasOwnProperty"), 3);
  assert.equal(Object.getPrototypeOf(persisted.at(-1)), null);
  assert.equal(Object.hasOwn(persisted.at(-1)!, "__proto__"), true);
});

test("prototype properties cannot masquerade as default avatar preferences", () => {
  profileAvatars.value = {};
  for (const profileId of ["constructor", "toString", "__proto__"]) {
    const avatar = avatarForProfile(profileId);
    assert.equal(avatar.kind, "creature");
  }
  setCreatureAvatar("__proto__", 3);
  assert.deepEqual(avatarForProfile("__proto__"), { kind: "creature", index: 3 });
  assert.equal(Object.hasOwn(profileAvatars.value, "__proto__"), true);
  profileAvatars.value = {};
});

test("malformed persisted avatar slots are compacted before new Profiles are assigned", () => {
  const persisted: Record<string, number> = {};
  const assignments = new AvatarOrdinalPreferences(
    { alpha: 900_000_000, beta: 2, gamma: 2, invalid: -1 },
    (next) => Object.assign(persisted, next),
  );
  assert.equal(assignments.ordinal("beta"), 0);
  assert.equal(assignments.ordinal("gamma"), 1);
  assert.equal(assignments.ordinal("alpha"), 2);
  assert.equal(assignments.ordinal("delta"), 3);
  assert.deepEqual(persisted, { beta: 0, gamma: 1, alpha: 2, delta: 3 });
});

test("stores separate creature choices and refuses a non-durable reset", async () => {
  profileAvatars.value = {};
  setCreatureAvatar("profile-a", 4);
  setCreatureAvatar("profile-b", 2);
  assert.deepEqual(avatarForProfile("profile-a"), { kind: "creature", index: 4 });
  assert.deepEqual(avatarForProfile("profile-b"), { kind: "creature", index: 2 });
  assert.equal(await resetProfileAvatar("profile-a"), false);
  assert.deepEqual(profileAvatars.value["profile-a"], { kind: "creature", index: 4 });
  profileAvatars.value = {};
});

test("validates image data URLs and reports unavailable durable storage", async () => {
  profileAvatars.value = {};
  const png = "data:image/png;base64,aGVsbG8=";
  assert.equal(isSafeImageDataUrl(png), true);
  assert.equal(await setCustomAvatar("profile-a", png), false);
  assert.equal(await setCustomAvatar("profile-a", "data:image/svg+xml,<svg onload=alert(1) />"), false);
  assert.equal(await setCustomAvatar("profile-a", "https://example.com/avatar.png"), false);
});
