import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("avatar picker keyboard focus skips the transparent file input", async () => {
  const source = await readFile(new URL("../src/components/avatar-picker.tsx", import.meta.url), "utf8");
  assert.match(source, /input:not\(\[disabled\]\):not\(\[tabindex="-1"\]\)/);
  assert.match(source, /<input ref=\{inputRef\} type="file" hidden aria-hidden="true" tabIndex=\{-1\}/);
  assert.match(source, /onClick=\{\(\) => inputRef\.current\?\.click\(\)\}/, "the visible upload button remains the file-picker entry point");
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

test("prototype-named Profiles are safe across default, custom, hydrate, reset, and persist paths", async () => {
  const store = new DeferredAvatarStore([["__proto__", FIRST_IMAGE]]);
  const initial = Object.fromEntries([["constructor", { kind: "creature" as const, index: 4 }]]);
  const persisted: AvatarMap[] = [];
  const preferences = new AvatarPreferences(initial, store, (next) => persisted.push(next));

  await preferences.hydrate();
  assert.deepEqual(preferences.avatars.value["constructor"], { kind: "creature", index: 4 });
  assert.deepEqual(preferences.avatars.value["__proto__"], { kind: "custom", dataUrl: FIRST_IMAGE });
  assert.equal(Object.getPrototypeOf(preferences.avatars.value), null);
  preferences.setCreature("toString", 2);
  await preferences.whenIdle("toString");
  assert.deepEqual(preferences.avatars.value["toString"], { kind: "creature", index: 2 });
  assert.equal(await preferences.setCustom("constructor", SECOND_IMAGE), true);
  assert.deepEqual(preferences.avatars.value["constructor"], { kind: "custom", dataUrl: SECOND_IMAGE });
  assert.equal(Object.hasOwn(persisted.at(-1)!, "__proto__"), true, "hydrate persists __proto__ as data, not as a setter");
  assert.equal(await preferences.reset("__proto__"), true);
  assert.equal(Object.hasOwn(preferences.avatars.value, "__proto__"), false);

  const reloaded = new AvatarPreferences(persisted.at(-1)!, store);
  await reloaded.hydrate();
  assert.deepEqual(reloaded.avatars.value["constructor"], { kind: "custom", dataUrl: SECOND_IMAGE });
  assert.deepEqual(reloaded.avatars.value["toString"], { kind: "creature", index: 2 });
  assert.equal(Object.hasOwn(reloaded.avatars.value, "__proto__"), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
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
