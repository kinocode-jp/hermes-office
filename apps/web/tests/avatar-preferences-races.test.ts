import assert from "node:assert/strict";
import test from "node:test";
import {
  AvatarPreferences,
  type AvatarAssetStore,
  type AvatarMap,
  type StoredCustomAvatar,
} from "../src/avatar-preferences.ts";
import { canDismissAvatarPicker } from "../src/components/avatar-picker.tsx";

const FIRST_IMAGE = "data:image/png;base64,Zmlyc3Q=";
const SECOND_IMAGE = "data:image/png;base64,c2Vjb25k";

test("avatar picker cannot be dismissed while a durable upload or reset is in flight", () => {
  assert.equal(canDismissAvatarPicker(false, false), true);
  assert.equal(canDismissAvatarPicker(true, false), false);
  assert.equal(canDismissAvatarPicker(false, true), false);
  assert.equal(canDismissAvatarPicker(true, true), false);
});

test("upload followed by a creature choice cannot restore stale custom state", async () => {
  const store = new DeferredAvatarStore();
  store.blockNext("put");
  const preferences = createPreferences(store);
  const generation = preferences.begin("profile-a");
  const upload = preferences.setCustom("profile-a", FIRST_IMAGE, generation);
  await store.waitUntilBlocked();
  preferences.setCreature("profile-a", 3);
  store.release();
  assert.equal(await upload, false);
  await preferences.whenIdle("profile-a");
  assert.deepEqual(preferences.avatars.value["profile-a"], { kind: "creature", index: 3 });
  assert.equal(store.records.has("profile-a"), false);
});

test("custom upload after a creature choice persists as the last action", async () => {
  const store = new DeferredAvatarStore([["profile-a", FIRST_IMAGE]]);
  store.blockNext("delete");
  const preferences = createPreferences(store);
  preferences.setCreature("profile-a", 2);
  await store.waitUntilBlocked();
  const generation = preferences.begin("profile-a");
  const upload = preferences.setCustom("profile-a", SECOND_IMAGE, generation);
  store.release();
  assert.equal(await upload, true);
  assert.deepEqual(preferences.avatars.value["profile-a"], { kind: "custom", dataUrl: SECOND_IMAGE });
  assert.equal(store.records.get("profile-a"), SECOND_IMAGE);
});

test("reset during hydration rejects the captured stale record and deletes it", async () => {
  const store = new DeferredAvatarStore([["profile-a", FIRST_IMAGE]]);
  store.blockNext("load");
  const preferences = createPreferences(store);
  const hydration = preferences.hydrate();
  await store.waitUntilBlocked();
  const reset = preferences.reset("profile-a");
  store.release();
  await hydration;
  assert.equal(await reset, true);
  assert.equal(preferences.avatars.value["profile-a"], undefined);
  assert.equal(store.records.has("profile-a"), false);
});

test("reset keeps the custom avatar visible when durable deletion fails and succeeds on retry", async () => {
  const store = new DeferredAvatarStore([["profile-a", FIRST_IMAGE]]);
  const preferences = createPreferences(store, { "profile-a": { kind: "custom", dataUrl: FIRST_IMAGE } });
  store.failNextDelete = true;
  assert.equal(await preferences.reset("profile-a"), false);
  assert.deepEqual(preferences.avatars.value["profile-a"], { kind: "custom", dataUrl: FIRST_IMAGE });
  assert.equal(store.records.get("profile-a"), FIRST_IMAGE);
  assert.equal(await preferences.reset("profile-a"), true);
  assert.equal(preferences.avatars.value["profile-a"], undefined);
  const reloaded = createPreferences(store);
  await reloaded.hydrate();
  assert.equal(reloaded.avatars.value["profile-a"], undefined);
});

test("a completed custom upload is restored by a new preference instance", async () => {
  const store = new DeferredAvatarStore();
  const first = createPreferences(store);
  assert.equal(await first.setCustom("profile-a", FIRST_IMAGE), true);
  const reloaded = createPreferences(store);
  await reloaded.hydrate();
  assert.deepEqual(reloaded.avatars.value["profile-a"], { kind: "custom", dataUrl: FIRST_IMAGE });
});

function createPreferences(store: AvatarAssetStore, initial: AvatarMap = {}): AvatarPreferences {
  return new AvatarPreferences(initial, store);
}

class DeferredAvatarStore implements AvatarAssetStore {
  readonly records: Map<string, string>;
  failNextDelete = false;
  #blockOperation: "delete" | "load" | "put" | undefined;
  #blocked: (() => void) | undefined;
  #blockedPromise: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;

  constructor(records: Array<[string, string]> = []) {
    this.records = new Map(records);
  }

  blockNext(operation: "delete" | "load" | "put"): void {
    this.#blockOperation = operation;
    this.#blockedPromise = new Promise((resolve) => { this.#blocked = resolve; });
  }

  async waitUntilBlocked(): Promise<void> {
    await this.#blockedPromise;
  }

  release(): void {
    this.#release?.();
  }

  async load(_legacy: Readonly<AvatarMap>): Promise<StoredCustomAvatar[]> {
    const captured = [...this.records].map(([profileId, dataUrl]) => ({ profileId, dataUrl }));
    await this.#maybeBlock("load");
    return captured;
  }

  async put(profileId: string, dataUrl: string): Promise<void> {
    await this.#maybeBlock("put");
    this.records.set(profileId, dataUrl);
  }

  async delete(profileId: string): Promise<void> {
    await this.#maybeBlock("delete");
    if (this.failNextDelete) { this.failNextDelete = false; throw new Error("delete failed"); }
    this.records.delete(profileId);
  }

  async #maybeBlock(operation: "delete" | "load" | "put"): Promise<void> {
    if (this.#blockOperation !== operation) return;
    this.#blockOperation = undefined;
    this.#blocked?.();
    await new Promise<void>((resolve) => { this.#release = resolve; });
    this.#release = undefined;
  }
}
