import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { hasOpenModal, isTopmostModal } from "../src/modal-layer.ts";

test("modal helpers identify the final aria-modal dialog as the only top layer", () => {
  const first = {} as HTMLElement;
  const second = {} as HTMLElement;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelectorAll: () => [first, second] },
  });
  try {
    assert.equal(hasOpenModal(), true);
    assert.equal(hasOpenModal(first), true);
    assert.equal(isTopmostModal(first), false);
    assert.equal(isTopmostModal(second), true);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
});

test("profile command and appearance controls consult the shared modal guard", async () => {
  const [command, appearance] = await Promise.all([
    readFile(new URL("../src/components/profile-command.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/appearance-settings.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(command, /!open && hasOpenModal\(\)/);
  assert.match(command, /isTopmostModal\(dialog\.current\)/);
  assert.match(appearance, /hasOpenModal\(\)/);
  assert.match(appearance, /isTopmostModal\(panel\.current\)/);
});
