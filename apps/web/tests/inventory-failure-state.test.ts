import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeSnapshot } from "../src/domain.ts";
import { initializeInventory, profileInventoryState, sessionInventoryState } from "../src/inventory.ts";
import { storedSessionClientId } from "../src/session-identity.ts";
import {
  applyOfficeSnapshot,
  getOpenChatTargets,
  openSession,
  openSessionIds,
  profileList,
  registerChatRuntime,
  sessions,
} from "../src/store.ts";

const SERVER_URL = "http://127.0.0.1:4317";

test("inventory failures retain live state while authoritative empty reads remove it", () => {
  const ensured: string[] = [];
  const released: string[] = [];
  registerChatRuntime({
    ensureSession: (target) => ensured.push(target.clientSessionId),
    releaseSession: (id) => released.push(id),
    submitPrompt: () => {}, interrupt: () => {},
    respondClarify: async () => {}, respondApproval: async () => {},
  });

  applyOfficeSnapshot(snapshot("complete", "complete", 1), SERVER_URL);
  const clientId = storedSessionClientId("profile-0", "session-0");
  sessions.value = sessions.value.map((session) => ({ ...session, messages: [{ id: "kept", from: "agent", body: "keep me", at: "00:00" }] }));
  openSession(clientId);
  assert.deepEqual(ensured, [clientId]);

  const profileFailure = snapshot("unavailable", "complete", 2);
  applyOfficeSnapshot(profileFailure, SERVER_URL);
  initializeInventory(profileFailure, SERVER_URL);
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["profile-0"]);
  assert.equal(sessions.value[0]?.messages[0]?.body, "keep me");
  assert.deepEqual(openSessionIds.value, [clientId]);
  assert.deepEqual(getOpenChatTargets(), [{ clientSessionId: clientId, profileId: "profile-0", storedSessionId: "session-0" }]);
  assert.deepEqual(ensured, [clientId], "an unavailable refresh must not create a second chat target");
  assert.deepEqual(released, []);
  assert.equal(profileInventoryState.value.partialFailures, 1);

  const recovery = snapshot("complete", "complete", 3);
  applyOfficeSnapshot(recovery, SERVER_URL);
  initializeInventory(recovery, SERVER_URL);
  assert.equal(sessions.value[0]?.messages[0]?.body, "keep me");
  assert.deepEqual(released, []);

  const sessionFailure = snapshot("complete", "unavailable", 4);
  applyOfficeSnapshot(sessionFailure, SERVER_URL);
  initializeInventory(sessionFailure, SERVER_URL);
  assert.equal(sessions.value[0]?.messages[0]?.body, "keep me");
  assert.deepEqual(openSessionIds.value, [clientId]);
  assert.deepEqual(released, []);
  assert.equal(sessionInventoryState.value.partialFailures, 1);

  applyOfficeSnapshot(snapshot("complete", "empty", 5), SERVER_URL);
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(openSessionIds.value, []);
  assert.deepEqual(released, [clientId]);

  applyOfficeSnapshot(snapshot("empty", "empty", 6), SERVER_URL);
  assert.deepEqual(profileList.value, []);
  applyOfficeSnapshot(snapshot("unavailable", "unavailable", 7), SERVER_URL);
  assert.deepEqual(profileList.value, [], "an initial unavailable read stays empty without inventing demo or stale state");
  assert.deepEqual(released, [clientId]);
});

type InventoryState = "complete" | "unavailable" | "empty";

function snapshot(profileState: InventoryState, sessionState: InventoryState, sequence: number): OfficeSnapshot {
  const profiles = profileState === "complete"
    ? [{ id: "profile-0", name: "Profile 0", activity: "idle", activeSessionCount: sessionState === "complete" ? 1 : 0 }]
    : [];
  const storedSessions = sessionState === "complete"
    ? [{ id: "session-0", profileId: "profile-0", title: "Session 0", activity: "idle" }]
    : [];
  return {
    generatedAt: new Date(sequence).toISOString(), sequence,
    capabilities: {
      protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" },
      access: { deviceId: "local-test", tier: "owner", exposure: "loopback", authentication: "local-cookie", allowedOperations: ["state.read"] },
      features: ["chat", "profiles"],
    },
    profiles,
    sessions: storedSessions,
    inventory: { profiles: page(profileState, profiles.length), sessions: page(sessionState, storedSessions.length) },
    boards: [],
  };
}

function page(state: InventoryState, count: number) {
  if (state === "unavailable") return { returned: 0, available: 0, hasMore: false, truncated: true, partialFailures: 1 };
  return { returned: count, available: count, total: count, hasMore: false, truncated: false, partialFailures: 0 };
}
