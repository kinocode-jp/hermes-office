import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { fontScales } from "../src/appearance.js";

const source = await readFile(new URL("../public/appearance-init.js", import.meta.url), "utf8");

test("appearance bootstrap applies every current font scale before application startup", () => {
  for (const fontScale of fontScales) {
    const root = runBootstrap({ theme: "midnight", fontScale });
    assert.equal(root.dataset.theme, "midnight");
    assert.equal(root.dataset.fontScale, String(fontScale).replace(".", "-"));
    assert.equal(root.properties.get("--font-scale"), String(fontScale));
    assert.equal(root.style.colorScheme, "dark");
  }
});

test("appearance bootstrap preserves legacy font-size choices through migration", () => {
  for (const [legacy, migrated] of [[0.9, 1], [1.1, 1.125], [1.2, 1.25]] as const) {
    const root = runBootstrap({ theme: "mint", fontScale: legacy });
    assert.equal(root.dataset.fontScale, String(migrated).replace(".", "-"));
    assert.equal(root.properties.get("--font-scale"), String(migrated));
  }
});

test("appearance bootstrap fails safely for invalid or unavailable preferences", () => {
  const invalid = runBootstrap({ theme: "unknown", fontScale: 99 });
  assert.equal(invalid.dataset.theme, "paper");
  assert.equal(invalid.dataset.fontScale, "1");
  assert.equal(invalid.properties.get("--font-scale"), "1");

  const unavailable = runBootstrap(undefined, true);
  assert.equal(unavailable.dataset.theme, "paper");
  assert.equal(unavailable.dataset.fontScale, "1");
  assert.equal(unavailable.properties.get("--font-scale"), "1");
  assert.equal(unavailable.style.colorScheme, "light");
});

type Root = {
  dataset: Record<string, string>;
  properties: Map<string, string>;
  style: { colorScheme: string; setProperty(name: string, value: string): void };
};

function runBootstrap(preferences?: unknown, storageThrows = false): Root {
  const properties = new Map<string, string>();
  const root: Root = {
    dataset: {},
    properties,
    style: {
      colorScheme: "",
      setProperty: (name, value) => properties.set(name, value),
    },
  };
  runInNewContext(source, {
    document: { documentElement: root },
    localStorage: {
      getItem: () => {
        if (storageThrows) throw new Error("storage unavailable");
        return preferences === undefined ? null : JSON.stringify(preferences);
      },
    },
  });
  return root;
}
