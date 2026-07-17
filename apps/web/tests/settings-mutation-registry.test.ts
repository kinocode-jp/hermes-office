import assert from "node:assert/strict";
import test from "node:test";
import { SettingsMutationRegistry } from "../src/settings-mutation-registry.ts";

test("settings mutations keep independent skill flights busy without allowing A-B-A duplicates", () => {
  const registry = new SettingsMutationRegistry();
  assert.equal(registry.start("skill:A", "skill:A"), true);
  assert.equal(registry.start("skill:B", "skill:B"), true);
  assert.equal(registry.start("skill:A", "skill:A"), false);
  assert.deepEqual([...registry.snapshot()], ["skill:A", "skill:B"]);

  registry.finish("skill:B");
  assert.equal(registry.hasKey("skill:A"), true, "finishing B must not make A clickable again");
  assert.equal(registry.hasKey("skill:B"), false);
  assert.equal(registry.start("skill:A", "skill:A"), false);

  registry.finish("skill:A");
  assert.equal(registry.start("skill:A", "skill:A"), true);
});

test("memory provider selection and provider config saves share one conflict scope", () => {
  const registry = new SettingsMutationRegistry();
  assert.equal(registry.start("provider", "memory"), true);
  assert.equal(registry.start("provider-config", "memory"), false);
  assert.equal(registry.hasScope("memory"), true);
  registry.finish("provider");
  assert.equal(registry.hasScope("memory"), false);
  assert.equal(registry.start("provider-config", "memory"), true);
});
