import assert from "node:assert/strict";
import test from "node:test";
import { collectHermesInventory, type HermesJsonResult } from "./hermes-inventory.js";

const MAX_EPOCH_SECONDS = 8_640_000_000_000;

test("mixed timestamp boundaries drop only malformed rows and mark the inventory partial", async () => {
  const throwingTimestamp = session("throws", 1);
  Object.defineProperty(throwingTimestamp, "started_at", { enumerable: true, get: () => { throw new Error("mapper fixture"); } });
  const rows = [
    session("epoch", 0),
    session("date-max", MAX_EPOCH_SECONDS),
    session("too-large", MAX_EPOCH_SECONDS + 1),
    session("negative", -1),
    session("nan", Number.NaN),
    session("infinity", Number.POSITIVE_INFINITY),
    { ...session("bad-ended", 1), ended_at: "not-a-number" },
    throwingTimestamp,
  ];
  const inventory = await collectHermesInventory(requester([profile(), profile("profile-normalized", -1)], rows));

  assert.deepEqual(inventory.sessions.map((item) => item.id), ["epoch", "date-max"]);
  assert.equal(inventory.sessions[0]?.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(inventory.sessions[1]?.createdAt, "+275760-09-13T00:00:00.000Z");
  assert.equal(inventory.sessionsState.total, rows.length);
  assert.equal(inventory.sessionsState.truncated, true);
  assert.equal(inventory.sessionsState.partialFailures, 6);
  assert.deepEqual(inventory.profiles.map((item) => item.id), ["profile-0", "profile-normalized"]);
  assert.equal(inventory.profiles[1]?.ownSkillCount, 0);
  assert.equal(inventory.profilesState.truncated, true);
  assert.equal(inventory.profilesState.partialFailures, 1);
});

test("unexpected collection exceptions become unavailable metadata and a later valid read recovers", async () => {
  const explosive = new Proxy(session("explosive", 1), {
    get(target, property, receiver) {
      if (property === "id") throw new Error("unexpected collection failure");
      return Reflect.get(target, property, receiver);
    },
  });
  const unavailable = await collectHermesInventory(requester([profile()], [explosive]));
  assert.deepEqual(unavailable.profiles, []);
  assert.deepEqual(unavailable.sessions, []);
  assert.deepEqual(unavailable.profilesState, { truncated: true, partialFailures: 1 });
  assert.deepEqual(unavailable.sessionsState, { truncated: true, partialFailures: 1 });

  const recovered = await collectHermesInventory(requester([profile()], [session("recovered", 1)]));
  assert.deepEqual(recovered.profiles.map((item) => item.id), ["profile-0"]);
  assert.deepEqual(recovered.sessions.map((item) => item.id), ["recovered"]);
  assert.equal(recovered.sessionsState.truncated, false);
  assert.equal(recovered.sessionsState.partialFailures, 0);

  const empty = await collectHermesInventory(requester([], []));
  assert.deepEqual(empty.profiles, []);
  assert.deepEqual(empty.sessions, []);
  assert.deepEqual(empty.profilesState, { total: 0, truncated: false, partialFailures: 0 });
  assert.deepEqual(empty.sessionsState, { total: 0, truncated: false, partialFailures: 0 });
});

function requester(profiles: Record<string, unknown>[], sessions: Record<string, unknown>[]) {
  return async (path: string): Promise<HermesJsonResult> => {
    if (path === "/api/profiles") return { value: { profiles }, bytes: 1 };
    if (path.startsWith("/api/profiles/sessions?")) {
      return { value: { sessions, total: sessions.length, errors: [] }, bytes: 1 };
    }
    throw new Error("unexpected fixture route");
  };
}

function profile(name = "profile-0", skillCount = 1): Record<string, unknown> {
  return { name, gateway_running: false, skill_count: skillCount };
}

function session(id: string, timestamp: number): Record<string, unknown> {
  return { id, profile: "profile-0", title: id, is_active: false, started_at: timestamp, last_active: timestamp };
}
