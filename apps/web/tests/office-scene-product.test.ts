import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cellCenter, generateWorld, type OfficeLayoutId, type OfficeSizeId } from "../src/office/sim.ts";

const layouts: OfficeLayoutId[] = ["studio", "lounge"];
const sizes: OfficeSizeId[] = ["s", "m", "l"];

test("25 assigned desk targets remain disjoint in every office preset", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/components/office-scene.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/office-scene.css", import.meta.url), "utf8")
  ]);
  const characterWidth = numericConstant(source, "CHAR_W");
  const characterHeight = numericConstant(source, "CHAR_H");
  const labelWidth = numericCssValue(styles, ".ow-char-name", "max-width");
  const visibleWidth = Math.max(characterWidth, labelWidth);

  for (const layout of layouts) {
    for (const size of sizes) {
      const world = generateWorld(layout, size, 25);
      const seats = world.desks.slice(0, 25).map(({ chair }) => cellCenter(chair));
      assert.equal(seats.length, 25, `${layout}/${size} must provide one exclusive seat per profile`);
      for (let left = 0; left < seats.length; left += 1) {
        for (let right = left + 1; right < seats.length; right += 1) {
          const first = seats[left]!;
          const second = seats[right]!;
          const overlaps = Math.abs(first.x - second.x) < visibleWidth
            && Math.abs(first.y - second.y) < characterHeight;
          assert.equal(overlaps, false, `${layout}/${size} seats ${left} and ${right} overlap`);
        }
      }
    }
  }

  assert.match(source, /DENSE_OFFICE_PROFILE_COUNT = 12/);
  assert.match(source, /denseLayout \? stableProfileIds/);
  assert.match(source, /if \(denseLayout \|\| window\.matchMedia/);
  assert.match(source, /placeCharactersAtAssignedDesks\(world, simRef\.current\)/);
  assert.match(source, /title=\{profile\.name\}/, "ellipsized names must expose their full value");
});

test("scene scaling and mobile fallback preserve accessible click targets", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/components/office-scene.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/office-scene.css", import.meta.url), "utf8")
  ]);
  const characterWidth = numericConstant(source, "CHAR_W");
  const characterHeight = numericConstant(source, "CHAR_H");
  const minimumScale = numericConstant(source, "MIN_INTERACTIVE_SCENE_SCALE");

  assert.ok(characterWidth * minimumScale >= 44);
  assert.ok(characterHeight * minimumScale >= 44);
  assert.match(source, /Math\.max\(fitScale, MIN_INTERACTIVE_SCENE_SCALE\)/);
  assert.match(styles, /\.office-stage \{[^}]*overflow: auto/);
  assert.match(styles, /\.office-world-frame \{[^}]*min-width: 100%[^}]*min-height: 100%/);
  assert.match(styles, /\.ow-char \{[^}]*min-width: 84px[^}]*min-height: 84px/);
  assert.match(styles, /\.office-row \{[^}]*min-height: max\(62px, var\(--target-mobile\)\)/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.office-wrap\[data-view="scene"\] \.office-list \{ display: grid; \}/);
  assert.match(source, /const effectiveView: OfficeView = denseRoster \? "list" : officeView\.value/);
  assert.match(source, /effectiveView === "scene" && <OfficeStage/);
  assert.match(source, /disabled=\{denseRoster\}/, "dense rosters must not expose an unreadable Scene option");
  assert.match(source, /office-density-note[^]*office\.denseList/);
});

test("office selection state is exposed to assistive technology", async () => {
  const source = await readFile(new URL("../src/components/office-scene.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-current=\{selectedProfileId\.value === profile\.id \? "true" : undefined\}/);
  assert.match(source, /aria-pressed=\{effectiveView === "scene"\}/);
  assert.match(source, /aria-pressed=\{effectiveView === "list"\}/);
  assert.match(source, /aria-pressed=\{officeLayout\.value === "studio"\}/);
  assert.match(source, /aria-pressed=\{officeLayout\.value === "lounge"\}/);
  assert.match(source, /aria-pressed=\{officeSize\.value === size\}/);
});

function numericConstant(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name} = ([0-9.]+);`));
  assert.ok(match, `${name} must be a numeric constant`);
  return Number(match[1]);
}

function numericCssValue(styles: string, selector: string, property: string): number {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escapedSelector} \\{[^}]*${property}: ([0-9.]+)px`));
  assert.ok(match, `${selector} must define ${property} in pixels`);
  return Number(match[1]);
}
