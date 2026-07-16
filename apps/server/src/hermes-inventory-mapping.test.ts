import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_INVENTORY_TIMESTAMP } from "@hermes-office/protocol";
import { collectHermesInventory, HermesInventoryCache, type HermesJsonResult } from "./hermes-inventory.js";

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

test("identity getter exceptions isolate one row and a later valid read recovers", async () => {
  const explosive = new Proxy(session("explosive", 1), {
    get(target, property, receiver) {
      if (property === "id") throw new Error("unexpected collection failure");
      return Reflect.get(target, property, receiver);
    },
  });
  const partial = await collectHermesInventory(requester([profile()], [explosive]));
  assert.deepEqual(partial.profiles.map((item) => item.id), ["profile-0"]);
  assert.deepEqual(partial.sessions, []);
  assert.deepEqual(partial.profilesState, { total: 1, truncated: false, partialFailures: 0 });
  assert.deepEqual(partial.sessionsState, { total: 1, truncated: true, partialFailures: 1 });

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

test("identity drops stay partial with or without an upstream total and complete recovery stays authoritative", async () => {
  const valid = session("valid", 1);
  const rows = [valid, { id: "missing-profile" }, { id: 7, profile: "profile-0" }, { ...valid }];
  for (const includeTotal of [true, false]) {
    const mixed = await collectHermesInventory(requester([profile()], rows, { includeTotal }));
    assert.deepEqual(mixed.sessions.map((item) => item.id), ["valid"]);
    assert.equal(mixed.sessionsState.total, includeTotal ? rows.length : undefined);
    assert.equal(mixed.sessionsState.truncated, true);
    assert.equal(mixed.sessionsState.partialFailures, 3);
  }

  const allInvalid = await collectHermesInventory(requester([profile()], [{ id: "missing-profile" }, { profile: "profile-0" }], { includeTotal: false }));
  assert.deepEqual(allInvalid.sessions, []);
  assert.deepEqual(allInvalid.sessionsState, { truncated: true, partialFailures: 2 });

  const recovered = await collectHermesInventory(requester([profile()], [valid], { includeTotal: false }));
  assert.deepEqual(recovered.sessions.map((item) => item.id), ["valid"]);
  assert.deepEqual(recovered.sessionsState, { truncated: false, partialFailures: 0 });
});

test("total-free pagination is complete while overlapping duplicate pages are explicitly partial", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => session(`session-${index}`, index));
  const complete = await collectHermesInventory(requester([profile()], rows, { includeTotal: false }));
  assert.equal(complete.sessions.length, 101);
  assert.deepEqual(complete.sessionsState, { truncated: false, partialFailures: 0 });

  const overlapping = await collectHermesInventory(requester([profile()], rows, { includeTotal: false, overlapSecondPage: true }));
  assert.equal(overlapping.sessions.length, 101);
  assert.deepEqual(overlapping.sessionsState, { truncated: true, partialFailures: 1 });
});

test("missing timestamps use a stable unknown sentinel and preserve cursor generations", async () => {
  const fields = [
    { id: "missing", profile: "profile-0" },
    { id: "epoch", profile: "profile-0", started_at: 0, last_active: 0 },
    { id: "mixed", profile: "profile-0", last_active: 0 },
  ];
  const mapped = await collectHermesInventory(requester([profile()], fields));
  assert.equal(mapped.sessions[0]?.createdAt, UNKNOWN_INVENTORY_TIMESTAMP);
  assert.equal(mapped.sessions[0]?.updatedAt, UNKNOWN_INVENTORY_TIMESTAMP);
  assert.equal(mapped.sessions[1]?.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(mapped.sessions[1]?.updatedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(mapped.sessions[2]?.createdAt, UNKNOWN_INVENTORY_TIMESTAMP);
  assert.equal(mapped.sessions[2]?.updatedAt, "1970-01-01T00:00:00.000Z");

  const rows = Array.from({ length: 101 }, (_, index) => ({ id: `missing-${index}`, profile: "profile-0" }));
  const firstInventory = await collectHermesInventory(requester([profile()], rows));
  const secondInventory = await collectHermesInventory(requester([profile()], rows));
  assert.deepEqual(secondInventory, firstInventory);
  const cache = new HermesInventoryCache({ maxGenerations: 1 });
  const first = cache.replace(firstInventory);
  const second = cache.replace(secondInventory);
  assert.equal(second.metadata.sessions.nextCursor, first.metadata.sessions.nextCursor);
  assert.deepEqual(cache.page("sessions", first.metadata.sessions.nextCursor!, 100).sessions.map((item) => item.id), ["missing-100"]);
});

function requester(
  profiles: Record<string, unknown>[],
  sessions: Record<string, unknown>[],
  options: { includeTotal?: boolean; overlapSecondPage?: boolean } = {},
) {
  return async (path: string): Promise<HermesJsonResult> => {
    if (path === "/api/profiles") return { value: { profiles }, bytes: 1 };
    if (path.startsWith("/api/profiles/sessions?")) {
      const offset = Number(new URL(path, "http://fixture.local").searchParams.get("offset") ?? 0);
      const page = options.overlapSecondPage && offset === 100
        ? [sessions[99]!, sessions[100]!]
        : sessions.slice(offset, offset + 100);
      return { value: { sessions: page, ...(options.includeTotal === false ? {} : { total: sessions.length }), errors: [] }, bytes: 1 };
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
