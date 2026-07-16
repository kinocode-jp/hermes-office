import assert from "node:assert/strict";
import test from "node:test";
import type { Operation } from "@hermes-office/protocol";
import type { OfficeSnapshot } from "../src/domain.ts";
import { canMutateSettingsTab, settingsMutationAccess } from "../src/settings-access.ts";

function snapshot(allowedOperations: Operation[], tier: "operator" | "manager" | "owner", exposure: "loopback" | "tailnet"): OfficeSnapshot {
  return {
    generatedAt: "2026-07-16T00:00:00.000Z",
    sequence: 1,
    capabilities: {
      protocolVersion: 1,
      serverVersion: "0.2.0",
      runtime: { state: "ready" },
      access: {
        deviceId: "device-1",
        tier,
        exposure,
        authentication: exposure === "loopback" ? "local-cookie" : "device-cookie",
        allowedOperations,
      },
    },
    profiles: [],
    sessions: [],
    boards: [],
  };
}

test("settings mutations fail closed for a remote operator snapshot", () => {
  const access = settingsMutationAccess(snapshot(
    ["state.read", "chat.session.create", "chat.message.send", "kanban.card.update"],
    "operator",
    "tailnet",
  ));

  assert.deepEqual(access, { global: false, skill: false, soul: false, memory: false, localOwner: false });
  assert.equal(canMutateSettingsTab(access, "global"), false);
  assert.equal(canMutateSettingsTab(access, "skills"), false);
  assert.equal(canMutateSettingsTab(access, "soul"), false);
  assert.equal(canMutateSettingsTab(access, "memory"), false);
});

test("each settings control follows its exact server-advertised operation", () => {
  const partial = settingsMutationAccess(snapshot(
    ["state.read", "profile.update", "memory.update"],
    "manager",
    "tailnet",
  ));
  assert.deepEqual(partial, { global: false, skill: false, soul: true, memory: true, localOwner: false });

  const owner = settingsMutationAccess(snapshot(
    ["state.read", "global-settings.update", "skill.enable", "profile.update", "memory.update"],
    "owner",
    "loopback",
  ));
  assert.deepEqual(owner, { global: true, skill: true, soul: true, memory: true, localOwner: true });
});

test("settings mutations remain disabled until a validated snapshot exists", () => {
  assert.deepEqual(settingsMutationAccess(undefined), {
    global: false,
    skill: false,
    soul: false,
    memory: false,
    localOwner: false,
  });
});
