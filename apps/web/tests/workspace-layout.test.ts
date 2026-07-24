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
  workspaceChatPrecedesSurface,
  workspaceSeparatorKeyShortcuts,
  workspaceResizeRatioFromDelta,
  workspacePointerIsOwner,
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

test("workspace DOM order follows dock direction without changing mobile overlay order", () => {
  assert.equal(workspaceChatPrecedesSurface("top", false, true), true);
  assert.equal(workspaceChatPrecedesSurface("left", false, true), true);
  assert.equal(workspaceChatPrecedesSurface("bottom", false, true), false);
  assert.equal(workspaceChatPrecedesSurface("right", false, true), false);
  for (const placement of ["top", "right", "bottom", "left"] as const) {
    assert.equal(workspaceChatPrecedesSurface(placement, true, true), false, "mobile always keeps main before its chat overlay");
    assert.equal(workspaceChatPrecedesSurface(placement, false, false), false, "an empty workspace keeps the compact main-first order");
  }
});

test("workspace separator advertises only resize keys for its current axis", () => {
  assert.equal(workspaceSeparatorKeyShortcuts("left"), "ArrowLeft ArrowRight Home End");
  assert.equal(workspaceSeparatorKeyShortcuts("right"), "ArrowLeft ArrowRight Home End");
  assert.equal(workspaceSeparatorKeyShortcuts("top"), "ArrowUp ArrowDown Home End");
  assert.equal(workspaceSeparatorKeyShortcuts("bottom"), "ArrowUp ArrowDown Home End");
});

test("workspace pointer resize uses gesture delta without separator offset jumps", () => {
  const approximately = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < Number.EPSILON);
  approximately(workspaceResizeRatioFromDelta(0.4, 100, 110, "left", 1000), 0.41);
  approximately(workspaceResizeRatioFromDelta(0.4, 100, 110, "right", 1000), 0.39);
  approximately(workspaceResizeRatioFromDelta(0.4, 100, 110, "top", 500), 0.42);
  approximately(workspaceResizeRatioFromDelta(0.4, 100, 110, "bottom", 500), 0.38);
  assert.equal(
    workspaceResizeRatioFromDelta(0.4, 10, 30, "left", 1000),
    workspaceResizeRatioFromDelta(0.4, 200, 220, "left", 1000),
    "only pointer delta affects the result",
  );
  assert.equal(workspaceResizeRatioFromDelta(0.4, 100, 100, "left", 1000), 0.4);
  assert.equal(workspaceResizeRatioFromDelta(0.4, 100, 200, "left", 0), 0.4);
});

test("workspace pointer ownership rejects unrelated and missing owners", () => {
  assert.equal(workspacePointerIsOwner(7, 7), true);
  assert.equal(workspacePointerIsOwner(7, 8), false);
  assert.equal(workspacePointerIsOwner(null, 7), false);
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
  assert.match(component, /const chatFirst = surfaceVisible && workspaceChatPrecedesSurface\(placement, mobile, hasChats\)/);
  assert.match(component, /const desktopDivider = surfaceVisible && hasChats && !mobile \? \(/);
  assert.match(component, /key="surface-pane"/);
  assert.match(component, /key="chat-pane"/);
  assert.match(component, /<Fragment key="desktop-divider">/);
  assert.match(component, /\{chatFirst && chatPane\}\s*\{!chatFirst && surfacePane\}\s*\{desktopDivider\}\s*\{chatFirst && surfacePane\}\s*\{!chatFirst && chatPane\}/);
  const separatorStart = component.indexOf('class="workspace-separator"');
  const separatorEnd = component.indexOf("/>", separatorStart);
  const dockControlsStart = component.indexOf('class="workspace-dock-controls"');
  assert.ok(separatorStart >= 0 && separatorEnd > separatorStart, "separator is a standalone element");
  assert.ok(dockControlsStart > separatorEnd, "dock controls are siblings after the separator");
  assert.doesNotMatch(component.slice(separatorStart, separatorEnd), /<button/, "separator has no interactive descendants");
  assert.match(component, /class="workspace-dock-controls" role="group"/);
  assert.match(component, /aria-orientation=/);
  assert.match(component, /aria-keyshortcuts=\{workspaceSeparatorKeyShortcuts\(placement\)\}/);
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
  assert.match(component, /placed: \(position: string\) => t\("layout\.placed", \{ position \}\)/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /workspace-drop-zones/);
  assert.match(component, /source === "chat" \? edge : oppositePlacement\(edge\)/);
  assert.match(component, /dropZone: \(source: DragSource, edge: string\) => t\("layout\.dropZone"/);
  assert.match(component, /copy\.dropZone\(drag\.source, labelForPlacement\(edge\)\)/);
  assert.equal(component.match(/hasPointerCapture\(event\.pointerId\)/g)?.length, 2, "capture ownership is checked by resize and the shared release helper");
  assert.equal(component.match(/releasePointerCapture\(event\.pointerId\)/g)?.length, 1, "pointer release is centralized");
  assert.match(component, /const resizeGestureRef = useRef<ResizeGesture \| null>\(null\)/);
  assert.match(component, /const effectiveRatioRef = useRef/);
  assert.match(component, /const finishResize = \(event\?: PointerEvent\) =>/);
  assert.match(component, /resizeGestureRef\.current = null;\s*resizingRef\.current = false;\s*if \(event\) releaseOwnedPointer\(event\)/);
  assert.match(component, /const cancelDockDrag = \(event\?: PointerEvent\) =>/);
  assert.match(component, /const dragRef = useRef<DockDrag \| null>\(null\)/);
  assert.match(component, /dragRef\.current = next;\s*setDrag\(next\);\s*event\.currentTarget\.setPointerCapture\(event\.pointerId\)/);
  assert.match(component, /event\.button !== 0 \|\| dragRef\.current \|\| resizeGestureRef\.current\) return/, "dock cannot start during either active layout pointer gesture");
  assert.match(component, /workspacePointerIsOwner\(current\.pointerId, event\.pointerId\)/);
  assert.match(component, /onPointerDown=\{beginResize\}/);
  assert.match(component, /startCoordinate: resizeAxisCoordinate\(placement, event\.clientX, event\.clientY\)/);
  assert.match(component, /startRatio: effectiveRatioRef\.current/);
  assert.match(component, /pointerId: event\.pointerId/);
  assert.match(component, /axisSize: placement === "left" \|\| placement === "right" \? rect\.width : rect\.height/);
  assert.match(component, /!host\.current \|\| resizeGestureRef\.current \|\| dragRef\.current\) return/, "resize cannot start twice or during a dock drag");
  assert.match(component, /event\.pointerId !== gesture\.pointerId/);
  assert.match(component, /if \(gesture\.placement !== placement\) \{\s*finishResize\(event\);\s*return;/, "a resize started on an obsolete placement is safely ended before applying another delta");
  const resizeKeyboardStart = component.indexOf("const resizeWithKeyboard");
  const resizeKeyboardEnd = component.indexOf("const dockWithKeyboard", resizeKeyboardStart);
  assert.match(component.slice(resizeKeyboardStart, resizeKeyboardEnd), /dragRef\.current \|\| resizeGestureRef\.current/, "keyboard resize is ignored during any pointer layout gesture");
  const dockKeyboardStart = component.indexOf("const dockWithKeyboard");
  const dockKeyboardEnd = component.indexOf("useEffect", dockKeyboardStart);
  assert.match(component.slice(dockKeyboardStart, dockKeyboardEnd), /dragRef\.current \|\| resizeGestureRef\.current/, "keyboard docking is ignored during any pointer layout gesture");
  assert.match(component, /workspaceResizeRatioFromDelta\(/);
  assert.match(component, /onLostPointerCapture=\{\(event\) => finishResize\(event\)\}/);
  assert.match(component, /onPointerUp=\{finishResize\}/);
  assert.match(component, /onPointerCancel=\{finishResize\}/);
  assert.equal(component.match(/onLostPointerCapture=\{\(event\) => cancelDockDrag\(event\)\}/g)?.length, 2);
  assert.match(component, /if \(hasChats && !mobile\) return;\s*finishResize\(\);\s*cancelDockDrag\(\);/);
  assert.match(component, /useEffect\(\(\) => \(\) => \{\s*const shouldPersist = resizingRef\.current \|\| resizeGestureRef\.current !== null;\s*resizeGestureRef\.current = null;[\s\S]*?persistWorkspaceLayout\(\);/);
  assert.match(component, /\{drag && hasChats && !mobile && \(/);
  const cancelStart = component.indexOf("const cancelDockDrag");
  const cancelEnd = component.indexOf("const beginDockDrag", cancelStart);
  assert.doesNotMatch(component.slice(cancelStart, cancelEnd), /commitDock/, "lost or cancelled dock capture never commits placement");
  assert.match(component.slice(cancelStart, cancelEnd), /dragRef\.current = null;\s*setDrag\(null\);\s*if \(event\) releaseOwnedPointer\(event\)/);
  const finishDockStart = component.indexOf("const finishDockDrag");
  const finishDockEnd = component.indexOf("const beginResize", finishDockStart);
  assert.match(component.slice(finishDockStart, finishDockEnd), /dragRef\.current = null;\s*setDrag\(null\);\s*releaseOwnedPointer\(event\);\s*commitDock\(current\.candidate\)/);
  assert.match(component, /resizeGestureRef\.current = null;\s*dragRef\.current = null;\s*resizingRef\.current = false;/);
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
  assert.match(officeStyles, /@media \(max-width: 767px\)[\s\S]*\.office-wrap\[data-view="scene"\] \.office-stage \{[\s\S]*min-height: clamp\(/);
  assert.doesNotMatch(officeStyles, /@media \(max-width: 767px\)[\s\S]*\.office-wrap\[data-view="scene"\] \.office-list \{ display: grid/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.main-stage \{[\s\S]*overflow-y: auto[\s\S]*touch-action: pan-y/);
  assert.match(styles, /\.workspace-layout-host \{[\s\S]*height: 100%[\s\S]*min-height: 0[\s\S]*overflow: hidden/);
  assert.match(styles, /\.workspace-layout-surface \{[\s\S]*height: 100%[\s\S]*min-height: 0[\s\S]*overflow: hidden/);
  assert.match(liveSettingsStyles, /@container workspace-surface \(max-width: 620px\)[\s\S]*\.live-settings__grid \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(liveSettingsStyles, /@container workspace-surface \(max-width: 440px\)[\s\S]*\.provider-fields \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(auditStyles, /@container workspace-surface \(max-width: 620px\)[\s\S]*\.access-audit__rail li \{ grid-template-columns/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.workspace-layout-host\[data-workspace-placement\][^{]*\{\s*display: block/);
  assert.match(styles, /\.workspace-drawer \{ position: fixed; inset: calc\(52px/);
  const emptyDrawerRule = styles.match(/\.workspace-layout-host\.is-empty \.workspace-drawer \{([^}]*)\}/)?.[1] ?? "";
  assert.match(emptyDrawerRule, /border-top: 1px solid var\(--line\)/);
  assert.match(emptyDrawerRule, /border-right: 0/);
  assert.match(emptyDrawerRule, /border-left: 0/);
  const emptyDrawerRuleIndex = styles.indexOf(".workspace-layout-host.is-empty .workspace-drawer");
  for (const placement of ["top", "right", "bottom", "left"] as const) {
    assert.match(styles, new RegExp(`data-workspace-placement="${placement}"`), `${placement} placement remains supported`);
    const placementDrawerIndex = styles.lastIndexOf(`[data-workspace-placement="${placement}"] .workspace-drawer`, emptyDrawerRuleIndex);
    if (placementDrawerIndex >= 0) assert.ok(emptyDrawerRuleIndex > placementDrawerIndex, `${placement} empty drawer normalization follows placement borders`);
  }
  assert.match(settings, /aria-live="polite"/);
  assert.match(settings, /resetWorkspaceLayout\(\)/);
});
