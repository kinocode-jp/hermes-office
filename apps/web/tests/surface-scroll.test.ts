import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { rememberSurfaceScroll, restoreSurfaceScroll, type SurfaceScrollPosition } from "../src/surface-scroll.ts";
import type { Surface } from "../src/domain.ts";

test("main surfaces retain independent scroll positions instead of inheriting the previous screen", () => {
  const positions = new Map<Surface, SurfaceScrollPosition>();
  const stage = { scrollTop: 318, scrollLeft: 12 };

  rememberSurfaceScroll(positions, "office", stage);
  stage.scrollTop = 664;
  stage.scrollLeft = 0;
  rememberSurfaceScroll(positions, "settings", stage);

  restoreSurfaceScroll(positions, "office", stage);
  assert.deepEqual(stage, { scrollTop: 318, scrollLeft: 12 });
  restoreSurfaceScroll(positions, "settings", stage);
  assert.deepEqual(stage, { scrollTop: 664, scrollLeft: 0 });
  restoreSurfaceScroll(positions, "kanban", stage);
  assert.deepEqual(stage, { scrollTop: 0, scrollLeft: 0 });
});

test("App remembers scroll events and restores the active surface during layout", async () => {
  const source = await readFile(new URL("../src/app.tsx", import.meta.url), "utf8");
  assert.match(source, /useLayoutEffect\(\(\) => \{[\s\S]*restoreSurfaceScroll\([^)]*activeSurface\.value/);
  assert.match(source, /onScroll=\{\(event\) => rememberSurfaceScroll\([^)]*activeSurface\.value/);
});
