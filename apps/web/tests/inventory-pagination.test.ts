import assert from "node:assert/strict";
import test from "node:test";
import { mergeInventoryPage } from "../src/inventory.ts";
import { getOpenChatTargets, openSession, profileList, sessions } from "../src/store.ts";

test("a stored session loaded after the snapshot page remains selectable and resumable", () => {
  profileList.value = [{ id: "profile-0", name: "Profile 0", role: "", status: "idle", color: "#64b7a7", sessions: 100, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [] }];
  sessions.value = Array.from({ length: 100 }, (_, index) => ({ id: `session-${index}`, storedSessionId: `session-${index}`, profileId: "profile-0", title: `Session ${index}`, status: "ready" as const, messages: [], remoteKind: "stored" as const }));

  mergeInventoryPage({
    kind: "sessions",
    profiles: [],
    sessions: [{ id: "session-100", profileId: "profile-0", title: "Session 100", activity: "idle" }],
    pagination: { returned: 1, available: 101, total: 101, hasMore: false, truncated: false, partialFailures: 0 },
  });
  openSession("session-100");

  assert.equal(sessions.value.at(-1)?.title, "Session 100");
  assert.deepEqual(getOpenChatTargets().at(-1), { clientSessionId: "session-100", profileId: "profile-0", storedSessionId: "session-100" });
});

test("a profile loaded after the snapshot page is added once in upstream order", () => {
  profileList.value = [];
  mergeInventoryPage({
    kind: "profiles",
    profiles: [
      { id: "profile-100", name: "Profile 100", activity: "idle", activeSessionCount: 0 },
      { id: "profile-101", name: "Profile 101", activity: "offline", activeSessionCount: 0 },
      { id: "profile-100", name: "duplicate", activity: "idle", activeSessionCount: 0 },
    ],
    sessions: [],
    pagination: { returned: 3, available: 102, total: 102, hasMore: false, truncated: false, partialFailures: 0 },
  });
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["profile-100", "profile-101"]);
});
