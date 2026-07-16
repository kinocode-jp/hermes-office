import assert from "node:assert/strict";
import test from "node:test";
import type { ProfileSummary } from "@hermes-office/protocol";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesInventoryCache } from "./hermes-inventory.js";
import { routeInventoryHttp } from "./inventory-http.js";

test("Office inventory route follows opaque cursors and rejects stale or ambiguous continuation", async () => {
  const cache = new HermesInventoryCache();
  const first = cache.replace({
    profiles: Array.from({ length: 101 }, (_, index) => profile(index)),
    sessions: [],
    profilesState: { total: 101, truncated: false, partialFailures: 0 },
    sessionsState: { total: 0, truncated: false, partialFailures: 0 },
  });
  const source = { inventoryPage: async (kind: "profiles" | "sessions", cursor: string, limit: number) => cache.page(kind, cursor, limit) } as unknown as HermesRuntimeSource;
  const cursor = first.metadata.profiles.nextCursor!;
  const valid = await routeInventoryHttp(source, new URL(`http://office.local/api/v1/inventory?kind=profiles&limit=100&cursor=${cursor}`));
  assert.equal(valid.status, 200);
  assert.deepEqual((valid.body as { profiles: ProfileSummary[] }).profiles.map((item) => item.id), ["profile-100"]);

  const ambiguous = await routeInventoryHttp(source, new URL(`http://office.local/api/v1/inventory?kind=profiles&kind=sessions&cursor=${cursor}`));
  assert.equal(ambiguous.status, 400);
  cache.replace({ profiles: [], sessions: [], profilesState: { total: 0, truncated: false, partialFailures: 0 }, sessionsState: { total: 0, truncated: false, partialFailures: 0 } });
  const stale = await routeInventoryHttp(source, new URL(`http://office.local/api/v1/inventory?kind=profiles&cursor=${cursor}`));
  assert.equal(stale.status, 409);
});

function profile(index: number): ProfileSummary {
  return { id: `profile-${index}`, name: `Profile ${index}`, avatarKey: `profile-${index}`, activity: "idle", activeSessionCount: 0, inheritedSkillCount: 0, ownSkillCount: 0, revision: 1 };
}
