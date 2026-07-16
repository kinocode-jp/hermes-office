import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeSnapshot } from "../src/domain.ts";
import {
  applyOfficeSnapshot,
  createSession,
  officeConnection,
  openSessionIds,
  profileList,
  sessions,
  setOfficeError
} from "../src/store.ts";

function snapshot(options: {
  demo?: boolean;
  state?: OfficeSnapshot["capabilities"]["runtime"]["state"];
  profiles?: OfficeSnapshot["profiles"];
} = {}): OfficeSnapshot {
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
    profiles: options.profiles ?? [{ id: "live-profile", name: "Live Profile", activity: "idle", activeSessionCount: 0 }],
    sessions: [],
    inventory: { profiles: emptyPage(), sessions: emptyPage() },
    boards: []
  };
}

function emptyPage() { return { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0 }; }

test("demo fixtures load only when the server explicitly advertises demo mode", () => {
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);

  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), "http://127.0.0.1:4317");
  assert.equal(officeConnection.value.source, "demo");
  assert.equal(officeConnection.value.state, "demo");
  assert.ok(profileList.value.length > 0);
  assert.ok(sessions.value.every((session) => session.remoteKind === "demo"));
});

test("real runtime errors, non-ready state, and empty inventory clear stale demo data", () => {
  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), "http://127.0.0.1:4317");
  applyOfficeSnapshot(snapshot({ state: "starting" }), "http://127.0.0.1:4317");
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(openSessionIds.value, []);

  applyOfficeSnapshot(snapshot(), "http://127.0.0.1:4317");
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["live-profile"]);
  applyOfficeSnapshot(snapshot({ profiles: [] }), "http://127.0.0.1:4317");
  assert.deepEqual(profileList.value, []);

  applyOfficeSnapshot(snapshot(), "http://127.0.0.1:4317");
  setOfficeError("runtime unavailable", "http://127.0.0.1:4317");
  assert.equal(officeConnection.value.source, "server");
  assert.equal(officeConnection.value.state, "error");
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  createSession("live-profile");
  assert.deepEqual(sessions.value, []);
});
