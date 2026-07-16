import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GlobalInheritanceCoordinator } from "./global-inheritance.js";
import type { HermesSettingsAdapter, SkillSettingsDto } from "./hermes-settings.js";
import { HermesSettingsError, OfficeGlobalSettingsStore } from "./hermes-settings.js";

test("global skills claim only Office-enabled pairs and persist provenance across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-global-inheritance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "global.json");
  const skills = new Map([
    ["coder", new Map([["browser", false]])],
    ["reviewer", new Map([["browser", true]])],
  ]);
  const mutations: Array<[string, string, boolean, boolean | undefined]> = [];
  const adapter = fakeSettings(skills, mutations);
  const first = new GlobalInheritanceCoordinator({
    store: new OfficeGlobalSettingsStore(file),
    settings: adapter,
    listProfiles: async () => ["coder", "reviewer"],
  });

  const enabled = await first.update({ expectedRevision: 0, skills: ["browser"] });
  assert.equal(enabled.skillSync.state, "ready");
  assert.equal(skills.get("coder")?.get("browser"), true);
  assert.equal(skills.get("reviewer")?.get("browser"), true);
  assert.deepEqual(mutations, [["coder", "browser", true, false]]);

  // A fresh coordinator reads durable provenance and disables only the pair it
  // originally enabled. reviewer's pre-enabled skill remains untouched.
  const restarted = new GlobalInheritanceCoordinator({
    store: new OfficeGlobalSettingsStore(file),
    settings: adapter,
    listProfiles: async () => ["coder", "reviewer"],
  });
  const removed = await restarted.update({ expectedRevision: 1, skills: [] });
  assert.equal(removed.skillSync.state, "ready");
  assert.equal(skills.get("coder")?.get("browser"), false);
  assert.equal(skills.get("reviewer")?.get("browser"), true);
  assert.deepEqual(mutations.at(-1), ["coder", "browser", false, true]);
});

test("profile override relinquishes ownership and global removal never overwrites it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-global-override-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const skills = new Map([["coder", new Map([["browser", false]])]]);
  const mutations: Array<[string, string, boolean, boolean | undefined]> = [];
  const coordinator = new GlobalInheritanceCoordinator({ store, settings: fakeSettings(skills, mutations), listProfiles: async () => ["coder"] });
  await coordinator.update({ expectedRevision: 0, skills: ["browser"] });

  await coordinator.noteProfileSkillOverride("coder", "browser");
  skills.get("coder")!.set("browser", false);
  await coordinator.update({ expectedRevision: 1, skills: [] });
  await coordinator.update({ expectedRevision: 2, skills: ["browser"] });

  assert.equal(skills.get("coder")?.get("browser"), false);
  assert.equal(mutations.length, 1, "global remove/re-add must not issue a second toggle after a Profile override");
});

test("failed materialization is explicit pending state and the next revision retries safely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-global-pending-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const skills = new Map([
    ["coder", new Map([["research", false]])],
    ["reviewer", new Map<string, boolean>()],
  ]);
  const coordinator = new GlobalInheritanceCoordinator({ store, settings: fakeSettings(skills, []), listProfiles: async () => ["coder", "reviewer"] });

  await assert.rejects(
    coordinator.update({ expectedRevision: 0, skills: ["research"], context: "Use verified sources.", sharedContextEnabled: true }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "rejected",
  );
  const pending = await coordinator.read();
  assert.equal(pending.revision, 1);
  assert.equal(pending.skillSync.state, "pending");
  assert.deepEqual(pending.skillSync.failures, [{ profile: "reviewer", skill: "research", operation: "enable" }]);
  assert.equal(await coordinator.sessionCreateContext(), "Use verified sources.");

  skills.get("reviewer")!.set("research", false);
  const retried = await coordinator.update({ expectedRevision: 1, skills: ["research"] });
  assert.equal(retried.revision, 2);
  assert.equal(retried.skillSync.state, "ready");
  assert.equal(skills.get("coder")?.get("research"), true);
  assert.equal(skills.get("reviewer")?.get("research"), true);

  const disabled = await coordinator.update({ expectedRevision: 2, sharedContextEnabled: false });
  assert.equal(disabled.sharedContextEnabled, false);
  assert.equal(await coordinator.sessionCreateContext(), undefined);
});

function fakeSettings(
  state: Map<string, Map<string, boolean>>,
  mutations: Array<[string, string, boolean, boolean | undefined]>,
): HermesSettingsAdapter {
  return {
    listSkills: async (profile) => [...(state.get(profile) ?? new Map())].map(([name, enabled]): SkillSettingsDto => ({ name, enabled, category: "test", description: "", provenance: "agent", usage: 0 })),
    setSkillEnabled: async (profile, name, enabled, expected) => {
      const profileSkills = state.get(profile);
      if (profileSkills === undefined || !profileSkills.has(name)) throw new HermesSettingsError("not_found", "missing");
      if (expected !== undefined && profileSkills.get(name) !== expected) throw new HermesSettingsError("conflict", "changed");
      mutations.push([profile, name, enabled, expected]);
      profileSkills.set(name, enabled);
    },
  } as HermesSettingsAdapter;
}
