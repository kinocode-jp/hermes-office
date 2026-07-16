import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeSnapshot } from "../src/domain.ts";
import {
  applyOfficeSnapshot,
  createSession,
  officeConnection,
  openSession,
  openSessionIds,
  profileList,
  registerChatRuntime,
  sessions,
  setOfficeError,
  tasks
} from "../src/store.ts";

const serverUrl = "http://127.0.0.1:4317";

function snapshot(options: {
  demo?: boolean;
  state?: OfficeSnapshot["capabilities"]["runtime"]["state"];
  profiles?: OfficeSnapshot["profiles"];
  sessions?: OfficeSnapshot["sessions"];
  profileInventory?: OfficeSnapshot["inventory"]["profiles"];
} = {}): OfficeSnapshot {
  const snapshotProfiles = options.profiles ?? [{ id: "live-profile", name: "Live Profile", activity: "idle", activeSessionCount: 0 }];
  const snapshotSessions = options.sessions ?? [];
  return {
    generatedAt: new Date(0).toISOString(),
    sequence: 1,
    capabilities: {
      protocolVersion: 1,
      serverVersion: "test",
      runtime: { state: options.state ?? "ready", adapterVersion: options.demo ? "test-demo" : "test" },
      access: {
        deviceId: "local-test",
        tier: "owner",
        exposure: "loopback",
        authentication: "local-cookie",
        allowedOperations: ["state.read"]
      },
      features: ["chat", "profiles", ...(options.demo ? ["demo" as const] : [])]
    },
    profiles: snapshotProfiles,
    sessions: snapshotSessions,
    inventory: {
      profiles: options.profileInventory ?? completePage(snapshotProfiles.length),
      sessions: completePage(snapshotSessions.length)
    },
    boards: []
  };
}

function completePage(count = 0) { return { returned: count, available: count, total: count, hasMore: false, truncated: false, partialFailures: 0 }; }
function unavailablePage() { return { returned: 0, available: 0, hasMore: false, truncated: true, partialFailures: 1 }; }

function resetRuntime(): void {
  applyOfficeSnapshot(snapshot({ state: "starting", profiles: [] }), serverUrl);
}

function recordChatRuntime(): { ensured: string[]; released: string[] } {
  const calls = { ensured: [] as string[], released: [] as string[] };
  registerChatRuntime({
    ensureSession: (target) => { calls.ensured.push(target.clientSessionId); },
    releaseSession: (sessionId) => { calls.released.push(sessionId); },
    submitPrompt: () => {},
    interrupt: () => {},
    respondClarify: async () => {},
    respondApproval: async () => {}
  });
  return calls;
}

test("demo fixtures load only when the server explicitly advertises demo mode", () => {
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);

  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);
  assert.equal(officeConnection.value.source, "demo");
  assert.equal(officeConnection.value.state, "demo");
  assert.ok(profileList.value.length > 0);
  assert.ok(sessions.value.every((session) => session.remoteKind === "demo"));
});

test("real runtime errors, non-ready state, and empty inventory clear stale demo data", () => {
  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);
  applyOfficeSnapshot(snapshot({ state: "starting" }), serverUrl);
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(openSessionIds.value, []);

  applyOfficeSnapshot(snapshot(), serverUrl);
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["live-profile"]);
  applyOfficeSnapshot(snapshot({ profiles: [] }), serverUrl);
  assert.deepEqual(profileList.value, []);

  applyOfficeSnapshot(snapshot(), serverUrl);
  setOfficeError("runtime unavailable", serverUrl);
  assert.equal(officeConnection.value.source, "server");
  assert.equal(officeConnection.value.state, "error");
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  createSession("live-profile");
  assert.deepEqual(sessions.value, []);
});

test("an initially unavailable live Profile inventory stays empty and reports degraded state", () => {
  resetRuntime();
  const calls = recordChatRuntime();

  applyOfficeSnapshot(snapshot({ profiles: [], profileInventory: unavailablePage() }), serverUrl);

  assert.equal(officeConnection.value.source, "server");
  assert.equal(officeConnection.value.state, "degraded");
  assert.match(officeConnection.value.message, /Profile一覧/);
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(openSessionIds.value, []);
  assert.deepEqual(calls, { ensured: [], released: [] });
});

test("demo to unavailable live transition clears every fixture without creating fake chat targets", () => {
  resetRuntime();
  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);
  assert.ok(openSessionIds.value.length > 0);
  const calls = recordChatRuntime();

  applyOfficeSnapshot(snapshot({ profiles: [], profileInventory: unavailablePage() }), serverUrl);

  assert.equal(officeConnection.value.state, "degraded");
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(tasks.value, []);
  assert.deepEqual(openSessionIds.value, []);
  assert.deepEqual(calls.ensured, []);
  assert.deepEqual(calls.released, []);
});

test("temporary live inventory failure and recovery retain last-known-good state without chat churn", () => {
  resetRuntime();
  const calls = recordChatRuntime();
  const live = snapshot({
    sessions: [{ id: "stored-session", profileId: "live-profile", title: "Live session", activity: "idle" }]
  });
  applyOfficeSnapshot(live, serverUrl);
  const liveSessionId = sessions.value[0]!.id;
  openSession(liveSessionId);
  assert.deepEqual(calls.ensured, [liveSessionId]);

  applyOfficeSnapshot(snapshot({ profiles: [], profileInventory: unavailablePage() }), serverUrl);
  assert.equal(officeConnection.value.state, "degraded");
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["live-profile"]);
  assert.deepEqual(sessions.value.map((session) => session.id), [liveSessionId]);
  assert.deepEqual(openSessionIds.value, [liveSessionId]);
  assert.deepEqual(calls, { ensured: [liveSessionId], released: [] });

  applyOfficeSnapshot(live, serverUrl);
  assert.equal(officeConnection.value.state, "connected");
  assert.deepEqual(openSessionIds.value, [liveSessionId]);
  assert.deepEqual(calls, { ensured: [liveSessionId], released: [] });
});

test("returning from live data to explicit demo releases live targets and replaces all state", () => {
  resetRuntime();
  const calls = recordChatRuntime();
  applyOfficeSnapshot(snapshot({
    sessions: [{ id: "stored-session", profileId: "live-profile", title: "Live session", activity: "idle" }]
  }), serverUrl);
  const liveSessionId = sessions.value[0]!.id;
  openSession(liveSessionId);

  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);

  assert.equal(officeConnection.value.state, "demo");
  assert.ok(profileList.value.length > 0);
  assert.ok(sessions.value.length > 0);
  assert.ok(sessions.value.every((session) => session.remoteKind === "demo"));
  assert.ok(openSessionIds.value.every((id) => id !== liveSessionId));
  assert.deepEqual(calls, { ensured: [liveSessionId], released: [liveSessionId] });
});
