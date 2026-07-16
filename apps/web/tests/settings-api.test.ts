import assert from "node:assert/strict";
import test from "node:test";
import { SettingsApiError, parseGlobalSettings } from "../src/settings-api.ts";

test("global settings retain skill sync failures", () => {
  const parsed = parseGlobalSettings({
    revision: 4,
    sharedSkillsEnabled: true,
    sharedContextEnabled: false,
    skills: ["coding"],
    context: "",
    updatedAt: "2026-07-16T00:00:00.000Z",
    skillSync: {
      state: "pending",
      failures: [{ profile: "builder", skill: "coding", operation: "enable" }],
    },
  });

  assert.equal(parsed.skillSync.state, "pending");
  assert.deepEqual(parsed.skillSync.failures, [
    { profile: "builder", skill: "coding", operation: "enable" },
  ]);
});

test("global settings reject unknown sync operations", () => {
  assert.throws(
    () => parseGlobalSettings({
      revision: 4,
      sharedSkillsEnabled: true,
      sharedContextEnabled: true,
      skills: [],
      context: "",
      updatedAt: "2026-07-16T00:00:00.000Z",
      skillSync: { state: "ready", failures: [{ profile: "builder", skill: "coding", operation: "delete" }] },
    }),
    SettingsApiError,
  );
});
