import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AvatarPreferences,
  type AvatarAssetStore,
  type AvatarMap,
  type StoredCustomAvatar,
} from "../src/avatar-preferences.ts";
import { canDismissAvatarPicker, containAvatarPickerTabFocus } from "../src/components/avatar-picker.tsx";

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
  assert.match(source, /button:not\(\[disabled\]\)/);
  assert.match(source, /input:not\(\[disabled\]\):not\(\[tabindex="-1"\]\)/);
  assert.match(source, /<input ref=\{inputRef\} type="file" hidden aria-hidden="true" tabIndex=\{-1\}/);
  assert.match(source, /onClick=\{\(\) => inputRef\.current\?\.click\(\)\}/, "the visible upload button remains the file-picker entry point");
});

test("avatar picker contains Tab focus when controls are unavailable or focus escaped", () => {
  const focused: string[] = [];
  const first = { focus: () => focused.push("first") };
  const last = { focus: () => focused.push("last") };
  const disabledDescendant = {};
  let controls: unknown[] = [];
  let dialog: HTMLElement;
  const descendants = new Set<unknown>([first, last, disabledDescendant]);
  dialog = {
    querySelectorAll: (selector: string) => {
      assert.match(selector, /button:not\(\[disabled\]\)/, "disabled buttons must not enter the focus ring");
      return controls;
    },
    contains: (element: unknown) => element === dialog || descendants.has(element),
    focus: () => focused.push("dialog"),
  } as unknown as HTMLElement;
  const tab = (activeElement: Element | null, shiftKey = false) => {
    let prevented = false;
    const event = { key: "Tab", shiftKey, preventDefault: () => { prevented = true; } };
    containAvatarPickerTabFocus(dialog, event, activeElement);
    assert.equal(prevented, true);
  };

  tab({} as Element);
  assert.deepEqual(focused, ["dialog"], "an all-disabled dialog retains focus on its focusable container");
  controls = [first, last];
  tab(dialog, true);
  tab(disabledDescendant as Element);
  tab({} as Element);
  tab({} as Element, true);
  tab(last as unknown as Element);
  tab(first as unknown as Element, true);
  assert.deepEqual(
    focused,
    ["dialog", "last", "first", "first", "last", "first", "last"],
    "dialog, disabled descendant, escaped, and boundary focus returns to the appropriate edge",
  );
});

test("avatar picker initially focuses close instead of opening the information tooltip", async () => {
  const source = await readFile(new URL("../src/components/avatar-picker.tsx", import.meta.url), "utf8");
  assert.match(source, /const closeButtonRef = useRef<HTMLButtonElement>\(null\)/);
  assert.match(source, /if \(closeButtonRef\.current\) closeButtonRef\.current\.focus\(\)/);
  assert.match(source, /<button ref=\{closeButtonRef\} type="button"/);
});

test("parent rerenders preserve focus inside the avatar picker", async () => {
  const source = await readFile(new URL("../src/components/avatar-picker.tsx", import.meta.url), "utf8");
  assert.match(source, /const onCloseRef = useRef\(onClose\);\s*busyRef\.current = busy;\s*onCloseRef\.current = onClose;/);
  assert.match(source, /if \(!busyRef\.current\) onCloseRef\.current\(\)/, "Escape uses the latest parent callback without restarting the modal effect");
  assert.match(source, /if \(closeButtonRef\.current\) closeButtonRef\.current\.focus\(\)[\s\S]*?document\.addEventListener\("keydown", handleKeyDown\);[\s\S]*?\}, \[\]\);/, "initial focus and focus restoration run only for the modal lifetime");
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
