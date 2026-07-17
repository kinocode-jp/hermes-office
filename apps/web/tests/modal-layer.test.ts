import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { hasOpenModal, isTopmostModal, modalDisplayLayer, registerModal } from "../src/modal-layer.ts";

test("modal stack follows explicit open sequence rather than DOM order", () => {
  const first = { isConnected: true } as HTMLElement;
  const second = { isConnected: true } as HTMLElement;
  const removeFirst = registerModal(first);
  const removeSecond = registerModal(second);
  assert.equal(hasOpenModal(), true);
  assert.equal(hasOpenModal(first), true);
  assert.equal(isTopmostModal(first), false);
  assert.equal(isTopmostModal(second), true);

  const reopenFirst = registerModal(first);
  assert.equal(isTopmostModal(first), true, "responsive reactivation gets a new explicit open sequence");
  removeFirst();
  assert.equal(isTopmostModal(first), true, "stale cleanup cannot unregister a reactivated modal");
  reopenFirst();
  assert.equal(isTopmostModal(second), true);
  removeSecond();
  assert.equal(hasOpenModal(), false);
});

test("outer stacking context outranks a descendant's larger local z-index", () => {
  const previousStyle = globalThis.getComputedStyle;
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: (element: { layer?: string }) => ({ zIndex: element.layer ?? "auto" }),
  });
  const profileLayer = { isConnected: true, layer: "80", parentElement: null } as unknown as HTMLElement;
  const topbar = { isConnected: true, layer: "50", parentElement: null } as unknown as HTMLElement;
  const appearance = { isConnected: true, layer: "90", parentElement: topbar } as unknown as HTMLElement;
  const removeAppearance = registerModal(appearance);
  const removeProfile = registerModal(profileLayer);
  try {
    assert.deepEqual(modalDisplayLayer(profileLayer), [80]);
    assert.deepEqual(modalDisplayLayer(appearance), [50, 90]);
    assert.equal(isTopmostModal(profileLayer), true, "a z50 stacking context cannot cover its z80 sibling");
    assert.equal(isTopmostModal(appearance), false);
  } finally {
    removeProfile();
    removeAppearance();
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: previousStyle });
  }
});

test("top modal locks non-modal siblings along every ancestor and restores prior state", () => {
  const previousElement = globalThis.HTMLElement;
  const previousStyle = globalThis.getComputedStyle;
  class FakeElement {
    isConnected = true;
    inert = false;
    parentElement: FakeElement | null;
    children: FakeElement[] = [];
    dataset: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
    constructor(readonly className = "", parent: FakeElement | null = null, readonly layer = "auto") {
      this.parentElement = parent;
      parent?.children.push(this);
    }
    closest(selector: string): FakeElement | null {
      for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    matches(selector: string): boolean {
      return selector === ".app-shell" ? this.className === "app-shell" : selector === "[data-modal-root]" && this.dataset.modalRoot !== undefined;
    }
    contains(target: FakeElement): boolean {
      for (let node: FakeElement | null = target; node; node = node.parentElement) if (node === this) return true;
      return false;
    }
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
  }
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (element: FakeElement) => ({ zIndex: element.layer }) });
  const shell = new FakeElement("app-shell");
  const topbar = new FakeElement("topbar", shell, "50");
  const profile = new FakeElement("profile-panel", shell, "80");
  const profileControl = new FakeElement("profile-control", profile);
  const dialog = new FakeElement("dialog", profile);
  const appearance = new FakeElement("appearance-dialog", topbar, "90");
  topbar.setAttribute("aria-hidden", "menu-state");
  const unregister = registerModal(dialog as unknown as HTMLElement);
  try {
    assert.equal(profileControl.inert, true, "same panel controls behind the modal are locked");
    assert.equal(topbar.inert, true, "siblings at the app-shell boundary are locked");
    assert.equal(topbar.getAttribute("aria-hidden"), "true");
    const unregisterAppearance = registerModal(appearance as unknown as HTMLElement);
    assert.equal(profile.inert, false, "a local z90 cannot escape the topbar's z50 stacking context");
    assert.equal(topbar.inert, true, "the actual z80 top modal keeps the topbar path locked");
    unregisterAppearance();
    assert.equal(profile.inert, false);
    assert.equal(profileControl.inert, true, "closing the top layer recomputes the remaining modal's background");
  } finally {
    unregister();
    assert.equal(profileControl.inert, false);
    assert.equal(topbar.inert, false);
    assert.equal(topbar.getAttribute("aria-hidden"), "menu-state");
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: previousStyle });
  }
});

test("profile command and appearance controls consult the shared modal guard", async () => {
  const [command, appearance] = await Promise.all([
    readFile(new URL("../src/components/profile-command.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/appearance-settings.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(command, /!open && hasOpenModal\(\)/);
  assert.match(command, /registerModal\(dialog\.current\)/);
  assert.match(command, /isTopmostModal\(dialog\.current\)/);
  assert.match(appearance, /hasOpenModal\(\)/);
  assert.match(appearance, /registerModal\(panel\.current\)/);
  assert.match(appearance, /isTopmostModal\(panel\.current\)/);
});

test("responsive and nested modals register with one shared keyboard owner", async () => {
  const [overlay, avatar] = await Promise.all([
    readFile(new URL("../src/components/use-mobile-overlay.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/avatar-picker.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(overlay, /kind === "modal" \? registerModal\(overlay\)/);
  assert.match(overlay, /kind === "modal" \? !isTopmostModal\(overlay\) : hasOpenModal\(\)/);
  assert.match(avatar, /registerModal\(dialog\)/);
  assert.match(avatar, /const currentDialog = dialogRef\.current;\s*if \(!currentDialog \|\| !isTopmostModal\(currentDialog\)\) return;/);
  const registry = await readFile(new URL("../src/modal-layer.ts", import.meta.url), "utf8");
  assert.match(registry, /backgroundLocks/);
  assert.match(registry, /lock\.count \+= 1/);
  assert.match(registry, /--lock\.count > 0/);
  assert.match(registry, /top\.contains\(target\)/);
});
