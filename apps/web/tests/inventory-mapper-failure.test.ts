import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeSnapshot } from "../src/domain.ts";
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

test("mixed mapper failures and unavailable fallback retain panes until authoritative empty", () => {
  const ensured: string[] = [];
  const released: string[] = [];
  registerChatRuntime({
    ensureSession: (target) => ensured.push(target.clientSessionId),
    releaseSession: (id) => released.push(id),
    submitPrompt: () => {}, interrupt: () => {},
    respondClarify: async () => {}, respondApproval: async () => {},
  });

  applyOfficeSnapshot(snapshot("complete", [stored("valid"), stored("malformed")], completePage(2), 1), SERVER_URL);
  const malformedId = storedSessionClientId("profile-0", "malformed");
  sessions.value = sessions.value.map((session) => session.id === malformedId
    ? { ...session, messages: [{ id: "kept", from: "agent", body: "keep live state", at: "00:00" }] }
    : session);
  openSession(malformedId);

  applyOfficeSnapshot(snapshot("complete", [stored("valid")], partialPage(1, 2), 2), SERVER_URL);
  assert.deepEqual(sessions.value.map((session) => session.storedSessionId), ["valid", "malformed"]);
  assert.equal(sessions.value.find((session) => session.id === malformedId)?.messages[0]?.body, "keep live state");
  assert.deepEqual(openSessionIds.value, [malformedId]);
  assert.deepEqual(getOpenChatTargets(), [{ clientSessionId: malformedId, profileId: "profile-0", storedSessionId: "malformed" }]);
  assert.deepEqual(released, []);

  applyOfficeSnapshot(snapshot("complete", [stored("valid"), stored("malformed")], completePage(2), 3), SERVER_URL);
  assert.equal(sessions.value.find((session) => session.id === malformedId)?.messages[0]?.body, "keep live state");
  const ensuresBeforeFallback = ensured.length;

  applyOfficeSnapshot(snapshot("unavailable", [], unavailablePage(), 4), SERVER_URL);
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["profile-0"]);
  assert.deepEqual(openSessionIds.value, [malformedId]);
  assert.equal(ensured.length, ensuresBeforeFallback, "top-level mapper fallback must not create another target");
  assert.deepEqual(released, []);

  applyOfficeSnapshot(snapshot("empty", [], completePage(0), 5), SERVER_URL);
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(openSessionIds.value, []);
  assert.deepEqual(released, [malformedId]);
});

type ProfileState = "complete" | "unavailable" | "empty";
type StoredRow = OfficeSnapshot["sessions"][number];
type Page = OfficeSnapshot["inventory"]["sessions"];

function snapshot(profileState: ProfileState, storedSessions: StoredRow[], sessionPage: Page, sequence: number): OfficeSnapshot {
  const profiles = profileState === "complete"
    ? [{ id: "profile-0", name: "Profile 0", activity: "idle", activeSessionCount: storedSessions.length }]
    : [];
  const profilePage = profileState === "unavailable" ? unavailablePage() : completePage(profiles.length);
  return {
    generatedAt: new Date(sequence).toISOString(), sequence,
    capabilities: {
      protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" },
      access: { deviceId: "local-test", tier: "owner", exposure: "loopback", authentication: "local-cookie", allowedOperations: ["state.read"] },
      features: ["chat", "profiles"],
    },
    profiles, sessions: storedSessions, inventory: { profiles: profilePage, sessions: sessionPage }, boards: [],
  };
}

function stored(id: string): StoredRow {
  return { id, profileId: "profile-0", title: id, activity: "idle" };
}

function completePage(count: number): Page {
  return { returned: count, available: count, total: count, hasMore: false, truncated: false, partialFailures: 0 };
}

function partialPage(returned: number, total: number): Page {
  return { returned, available: returned, total, hasMore: false, truncated: true, partialFailures: total - returned };
}

function unavailablePage(): Page {
  return { returned: 0, available: 0, hasMore: false, truncated: true, partialFailures: 1 };
}
