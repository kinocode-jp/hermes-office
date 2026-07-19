import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WORKSPACE_LAYOUT_STORAGE_KEY,
  clampWorkspaceRatio,
  defaultWorkspaceLayout,
  normalizeWorkspaceLayout,
  oppositePlacement,
  persistWorkspaceLayout,
  readWorkspaceLayout,
  resetWorkspaceLayout,
  workspacePlacement,
  workspaceRatio,
} from "../src/workspace-layout.ts";

test("workspace layout accepts only its exact versioned schema", () => {
  assert.deepEqual(normalizeWorkspaceLayout({ version: 1, placement: "left", ratio: 0.4 }), {
    version: 1, placement: "left", ratio: 0.4,
  });
  for (const invalid of [
    null,
    { version: 2, placement: "left", ratio: 0.4 },
    { version: 1, placement: "diagonal", ratio: 0.4 },
    { version: 1, placement: "left", ratio: "0.4" },
    { version: 1, placement: "left", ratio: 0.4, extra: true },
  ]) assert.deepEqual(normalizeWorkspaceLayout(invalid), defaultWorkspaceLayout);
  assert.equal(normalizeWorkspaceLayout({ version: 1, placement: "top", ratio: 9 }).ratio, 0.72);
});

test("workspace ratio respects both global limits and available pane size", () => {
  assert.equal(clampWorkspaceRatio(0.1, "left", 1000, 700), 0.24);
  assert.equal(clampWorkspaceRatio(0.9, "right", 1000, 700), 0.72);
  assert.equal(clampWorkspaceRatio(0.2, "bottom", 1000, 600), 0.4);
  assert.equal(oppositePlacement("top"), "bottom");
  assert.equal(oppositePlacement("left"), "right");
});

test("workspace preferences persist, reset, and fail safely when storage is blocked", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  workspacePlacement.value = "right";
  workspaceRatio.value = 0.42;
  assert.equal(persistWorkspaceLayout(storage), true);
  assert.deepEqual(readWorkspaceLayout(storage), { version: 1, placement: "right", ratio: 0.42 });
  assert.ok(values.has(WORKSPACE_LAYOUT_STORAGE_KEY));
  assert.equal(resetWorkspaceLayout(storage), true);
  assert.deepEqual({ placement: workspacePlacement.value, ratio: workspaceRatio.value }, {
    placement: defaultWorkspaceLayout.placement,
    ratio: defaultWorkspaceLayout.ratio,
  });
  assert.equal(values.has(WORKSPACE_LAYOUT_STORAGE_KEY), false);

  const blocked = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.deepEqual(readWorkspaceLayout(blocked), defaultWorkspaceLayout);
  assert.equal(persistWorkspaceLayout(blocked), false);
  assert.equal(resetWorkspaceLayout(blocked), false);
});

test("workspace interaction contract keeps mobile fixed and exposes pointer plus keyboard controls", async () => {
  const [component, styles, settings] = await Promise.all([
    readFile(new URL("../src/components/workspace-layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/appearance-settings.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(component, /role="separator"/);
  const separatorStart = component.indexOf('class="workspace-separator"');
  const separatorEnd = component.indexOf("/>", separatorStart);
  const dockControlsStart = component.indexOf('class="workspace-dock-controls"');
  assert.ok(separatorStart >= 0 && separatorEnd > separatorStart, "separator is a standalone element");
  assert.ok(dockControlsStart > separatorEnd, "dock controls are siblings after the separator");
  assert.doesNotMatch(component.slice(separatorStart, separatorEnd), /<button/, "separator has no interactive descendants");
  assert.match(component, /class="workspace-dock-controls" role="group"/);
  assert.match(component, /aria-orientation=/);
  assert.match(component, /aria-valuemin=/);
  assert.match(component, /onPointerMove=/);
  assert.match(component, /event\.key === "Home"/);
  assert.match(component, /event\.key === "End"/);
  assert.match(component, /event\.altKey.*event\.ctrlKey/);
  assert.match(component, /locale\.value === "ja"/);
  assert.match(component, /Chat placed on the/);
  assert.match(component, /チャットを\$\{position\}へ配置しました/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /workspace-drop-zones/);
  assert.match(component, /source === "chat" \? edge : oppositePlacement\(edge\)/);
  assert.equal(component.match(/hasPointerCapture\(event\.pointerId\)/g)?.length, 4, "release and resize paths check capture state");
  assert.equal(component.match(/releasePointerCapture\(event\.pointerId\)/g)?.length, 3, "release is used only in guarded completion paths");
  assert.match(component, /const ratioRef = useRef/);
  assert.match(component, /new ResizeObserver\(update\)[\s\S]*?\}, \[placement\]\);/);
  assert.doesNotMatch(component, /new ResizeObserver\(update\)[\s\S]*?\}, \[placement, workspaceRatio\.value\]\);/);
  assert.match(styles, /\.workspace-dock-controls \{[^}]*grid-area: separator[^}]*pointer-events: none/);
  assert.match(styles, /\.workspace-dock-controls > button \{ pointer-events: auto; \}/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.workspace-layout-host\[data-workspace-placement\][^{]*\{ display: block/);
  assert.match(styles, /\.workspace-drawer \{ position: fixed; inset: calc\(52px/);
  assert.match(settings, /aria-live="polite"/);
  assert.match(settings, /resetWorkspaceLayout\(\)/);
});
