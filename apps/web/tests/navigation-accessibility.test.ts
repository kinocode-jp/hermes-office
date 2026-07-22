import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { InspectorTab, Surface } from "../src/domain.ts";
import { inspectorTabIsSelected, surfaceAriaCurrent } from "../src/navigation-state.ts";

test("primary navigation exposes the current destination through state transitions", () => {
  let active: Surface = "office";
  assert.equal(surfaceAriaCurrent(active, "office"), "page");
  assert.equal(surfaceAriaCurrent(active, "kanban"), undefined);
  active = "kanban";
  assert.equal(surfaceAriaCurrent(active, "office"), undefined);
  assert.equal(surfaceAriaCurrent(active, "kanban"), "page");
});

test("Profile mode buttons expose their pressed state through state transitions", () => {
  let active: InspectorTab = "chat";
  assert.equal(inspectorTabIsSelected(active, "chat"), true);
  assert.equal(inspectorTabIsSelected(active, "skills"), false);
  active = "skills";
  assert.equal(inspectorTabIsSelected(active, "chat"), false);
  assert.equal(inspectorTabIsSelected(active, "skills"), true);
});

test("navigation components wire the computed state to their rendered controls", async () => {
  const [sideRail, profilePanel] = await Promise.all([
    readFile(new URL("../src/components/side-rail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/profile-panel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(sideRail, /aria-current=\{activeSurface\.value === item\.id \? "page" : undefined\}/);
  assert.match(profilePanel, /aria-pressed=\{inspectorTabIsSelected\(inspectorTab\.value, tab\.id\)\}/);
});
