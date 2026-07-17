import assert from "node:assert/strict";
import test from "node:test";
import {
  AvatarPreferences,
  type AvatarAssetStore,
  type AvatarMap,
  type StoredCustomAvatar,
} from "../src/avatar-preferences.ts";

const FIRST_IMAGE = "data:image/png;base64,Zmlyc3Q=";
const SECOND_IMAGE = "data:image/png;base64,c2Vjb25k";

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
  preferences.reset("profile-a");
  store.release();
  await hydration;
  await preferences.whenIdle("profile-a");
  assert.equal(preferences.avatars.value["profile-a"], undefined);
  assert.equal(store.records.has("profile-a"), false);
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
