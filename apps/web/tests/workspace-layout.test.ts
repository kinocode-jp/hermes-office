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
  workspaceRatioBounds,
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
  assert.deepEqual(workspaceRatioBounds("left", 1000, 700), { min: 0.28, max: 0.57 });
  assert.deepEqual(workspaceRatioBounds("right", 1000, 700, { main: 420, chat: 300 }), { min: 0.3, max: 0.55 });
  assert.deepEqual(workspaceRatioBounds("bottom", 1000, 600), { min: 0.4, max: 0.55 });
  assert.deepEqual(workspaceRatioBounds("bottom", 1000, 400), { min: 0.4625, max: 0.4625 });
  assert.equal(clampWorkspaceRatio(0.1, "left", 1000, 700), 0.28);
  assert.equal(clampWorkspaceRatio(0.9, "right", 1000, 700), 0.57);
  assert.equal(clampWorkspaceRatio(0.2, "bottom", 1000, 600), 0.4);
  assert.equal(oppositePlacement("top"), "bottom");
  assert.equal(oppositePlacement("left"), "right");
});

test("workspace ratio conflict minimizes asymmetric pane violations and remains finite", () => {
  const width708 = workspaceRatioBounds("left", 708, 700);
  assert.ok(Math.abs(width708.min - 279 / 708) < Number.EPSILON);
  assert.equal(width708.max, width708.min);
  assert.ok(Math.abs(width708.min * 708 - 279) < Number.EPSILON * 708, "chat and main each yield one pixel");
  assert.ok(Math.abs((708 - 30 - width708.max * 708) - 399) < Number.EPSILON * 708);

  const width709 = workspaceRatioBounds("right", 709, 700);
  assert.ok(Math.abs(width709.min - 279.5 / 709) < Number.EPSILON);
  assert.equal(width709.max, width709.min);
  assert.deepEqual(workspaceRatioBounds("left", 710, 700), { min: 280 / 710, max: 280 / 710 });

  assert.deepEqual(workspaceRatioBounds("bottom", 1000, 400), { min: 0.4625, max: 0.4625 });
  for (const width of [1, Number.MIN_VALUE]) {
    const extreme = workspaceRatioBounds("left", width, 700);
    assert.deepEqual(extreme, { min: 0.18, max: 0.18 });
    assert.equal(Number.isFinite(extreme.min), true);
  }
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
  const [component, styles, settings, officeStyles, liveSettingsStyles, auditStyles] = await Promise.all([
    readFile(new URL("../src/components/workspace-layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/appearance-settings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/office-scene.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/live-settings.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/access-audit.css", import.meta.url), "utf8"),
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
  assert.match(component, /event\.key === "Home"\) next = effectiveBounds\.min/);
  assert.match(component, /event\.key === "End"\) next = effectiveBounds\.max/);
  assert.match(component, /aria-valuemin=\{Math\.round\(effectiveBounds\.min \* 100\)\}/);
  assert.match(component, /aria-valuemax=\{Math\.round\(effectiveBounds\.max \* 100\)\}/);
  assert.match(component, /setEffectiveBounds\(workspaceRatioBounds\(placement, rect\.width, rect\.height\)\)/);
  assert.match(component, /event\.altKey.*event\.ctrlKey/);
  assert.match(component, /locale\.value === "ja"/);
  assert.match(component, /Chat placed on the/);
  assert.match(component, /チャットを\$\{position\}へ配置しました/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /workspace-drop-zones/);
  assert.match(component, /source === "chat" \? edge : oppositePlacement\(edge\)/);
  assert.match(component, /dropZone: \(source: DragSource, edge: string\).*オフィス.*チャット/);
  assert.match(component, /copy\.dropZone\(drag\.source, labelForPlacement\(edge, isJapanese\)\)/);
  assert.equal(component.match(/hasPointerCapture\(event\.pointerId\)/g)?.length, 2, "capture ownership is checked by resize and the shared release helper");
  assert.equal(component.match(/releasePointerCapture\(event\.pointerId\)/g)?.length, 1, "pointer release is centralized");
  assert.match(component, /const finishResize = \(\) => \{\s*if \(!resizingRef\.current\) return;/);
  assert.match(component, /const cancelDockDrag = \(event\?: PointerEvent\) =>/);
  assert.match(component, /onLostPointerCapture=\{finishResize\}/);
  assert.equal(component.match(/onLostPointerCapture=\{\(\) => cancelDockDrag\(\)\}/g)?.length, 2);
  assert.match(component, /if \(hasChats && !mobile\) return;\s*finishResize\(\);\s*cancelDockDrag\(\);/);
  assert.match(component, /useEffect\(\(\) => \(\) => \{\s*if \(!resizingRef\.current\) return;[\s\S]*?persistWorkspaceLayout\(\);/);
  assert.match(component, /\{drag && hasChats && !mobile && \(/);
  const cancelStart = component.indexOf("const cancelDockDrag");
  const cancelEnd = component.indexOf("const beginDockDrag", cancelStart);
  assert.doesNotMatch(component.slice(cancelStart, cancelEnd), /commitDock/, "lost or cancelled dock capture never commits placement");
  assert.match(component, /const ratioRef = useRef/);
  assert.match(component, /new ResizeObserver\(update\)[\s\S]*?\}, \[placement\]\);/);
  assert.doesNotMatch(component, /new ResizeObserver\(update\)[\s\S]*?\}, \[placement, workspaceRatio\.value\]\);/);
  assert.match(styles, /\.workspace-dock-controls \{[^}]*grid-area: separator[^}]*pointer-events: none/);
  assert.match(styles, /\.workspace-dock-controls > button \{ pointer-events: auto; \}/);
  assert.match(styles, /"separator" 30px/);
  assert.match(styles, /\.workspace-dock-handle \{[^}]*width: 28px[^}]*height: 28px/);
  assert.match(styles, /\.workspace-layout-surface \{[^}]*container-type: inline-size[^}]*container-name: workspace-surface/);
  assert.match(styles, /@container workspace-surface \(max-width: 620px\)[\s\S]*\.control-grid \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(officeStyles, /@container workspace-surface \(max-width: 520px\)[\s\S]*\.office-heading \{[^}]*flex-wrap: wrap/);
  assert.match(officeStyles, /@container workspace-surface \(max-width: 400px\)[\s\S]*\.office-toolbar \{[^}]*grid-template-columns/);
  assert.match(officeStyles, /@media \(max-width: 767px\)[\s\S]*\.office-wrap\[data-view="scene"\] \.office-list \{ display: grid; \}/);
  assert.match(liveSettingsStyles, /@container workspace-surface \(max-width: 620px\)[\s\S]*\.live-settings__grid \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(liveSettingsStyles, /@container workspace-surface \(max-width: 440px\)[\s\S]*\.provider-fields \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(auditStyles, /@container workspace-surface \(max-width: 620px\)[\s\S]*\.access-audit__rail li \{ grid-template-columns/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.workspace-layout-host\[data-workspace-placement\][^{]*\{ display: block/);
  assert.match(styles, /\.workspace-drawer \{ position: fixed; inset: calc\(52px/);
  assert.match(settings, /aria-live="polite"/);
  assert.match(settings, /resetWorkspaceLayout\(\)/);
});
