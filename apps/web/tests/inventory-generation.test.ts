import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession, OfficeInventoryPagination, OfficeSnapshot, OfficeSnapshotProfile, OfficeSnapshotRequestIdentity, Profile } from "../src/domain.ts";
import { initializeInventory, loadMoreProfiles, loadMoreSessions } from "../src/inventory.ts";
import { storedSessionClientId } from "../src/session-identity.ts";
import { activeSessionId, applyOfficeSnapshot, openSessionIds, profileList, registerChatRuntime, selectedProfileId, sessions } from "../src/store.ts";

test("a complete session generation upserts extras, prunes unseen rows, and releases an open target once", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55201";
  const pages = [sessionPage([stored("p0", "keep", "Updated", "using-tool")], terminal(1))];
  globalThis.fetch = inventoryFetch(pages);
  const keepId = storedSessionClientId("p0", "keep");
  const deleteId = storedSessionClientId("p0", "delete");
  const released: string[] = [];
  profileList.value = [profile("p0")];
  sessions.value = [
    storedClient("p0", "keep", "Old", { connectionState: "ready", historyState: "loaded", messages: [{ id: "kept", from: "agent", body: "local", at: "00:00" }] }),
    storedClient("p0", "delete", "Delete", { connectionState: "ready" }),
    { id: "draft", profileId: "p0", title: "Draft", status: "ready", messages: [], remoteKind: "draft", connectionState: "ready", historyState: "unloaded" }
  ];
  openSessionIds.value = [keepId, deleteId];
  activeSessionId.value = deleteId;
  registerRuntime(released);

  try {
    const firstRows = Array.from({ length: 100 }, (_, index) => stored("p0", `first-${index}`, `First ${index}`));
    const first = snapshot({ sessions: firstRows, sessionPage: continuing(100, "sessions-next") });
    applyOfficeSnapshot(first, serverUrl);
    initializeInventory(first, identity(serverUrl, 1));
    await loadMoreSessions();

    const keep = sessions.value.find((session) => session.id === keepId);
    assert.equal(keep?.title, "Updated");
    assert.equal(keep?.status, "streaming");
    assert.equal(keep?.messages[0]?.body, "local");
    assert.equal(keep?.connectionState, "ready");
    assert.equal(keep?.historyState, "loaded");
    assert.equal(sessions.value.some((session) => session.id === deleteId), false);
    assert.equal(sessions.value.some((session) => session.id === "draft"), true);
    assert.deepEqual(released, [deleteId]);
    assert.deepEqual(openSessionIds.value, [keepId]);
    assert.equal(activeSessionId.value, keepId);
    assert.equal(profileList.value[0]?.sessions, 102);

    const reuse = snapshot({ sessions: firstRows, sessionPage: continuing(100, "reuse-next"), sequence: 2 });
    applyOfficeSnapshot(reuse, serverUrl);
    initializeInventory(reuse, identity(serverUrl, 2));
    pages.push(sessionPage([stored("p0", "delete", "Reused")], terminal(1)));
    await loadMoreSessions();

    const reused = sessions.value.find((session) => session.id === deleteId);
    assert.equal(reused?.title, "Reused");
    assert.deepEqual(reused?.messages, []);
    assert.equal(reused?.connectionState, "disconnected");
    assert.deepEqual(released, [deleteId, keepId]);
  } finally {
    browser.restore();
  }
});

test("profile pages upsert server fields, preserve UI fields, and prune only at a complete terminal", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55202";
  const pageOne = profilePage([
    { id: "update", name: "Updated", activity: "blocked", activeSessionCount: 7 },
    { id: "update", name: "Duplicate loses", activity: "idle", activeSessionCount: 0 }
  ], continuing(2, "profiles-final"));
  const pageTwo = profilePage([{ id: "new", name: "New", activity: "idle", activeSessionCount: 0 }], terminal(1));
  const pages = [pageOne, pageTwo];
  globalThis.fetch = inventoryFetch(pages);
  profileList.value = [
    profile("p0"),
    { ...profile("update"), name: "Old", role: "Custom role", color: "#123456", memoryNote: "custom", skills: ["local-skill"] },
    profile("delete"),
    { ...profile("draft-profile"), role: "Draft owner" }
  ];
  sessions.value = [{ id: "local-draft", profileId: "draft-profile", title: "Draft", status: "ready", messages: [], remoteKind: "draft" }];
  selectedProfileId.value = "delete";

  try {
    const firstProfiles = Array.from({ length: 100 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, activity: "idle", activeSessionCount: 0 }));
    const first = snapshot({ profiles: firstProfiles, profilePage: continuing(100, "profiles-next") });
    applyOfficeSnapshot(first, serverUrl);
    initializeInventory(first, identity(serverUrl, 10));
    await loadMoreProfiles();

    const updatedBeforeTerminal = profileList.value.find((profile) => profile.id === "update");
    assert.equal(updatedBeforeTerminal?.name, "Updated");
    assert.equal(updatedBeforeTerminal?.status, "blocked");
    assert.equal(updatedBeforeTerminal?.sessions, 7);
    assert.equal(updatedBeforeTerminal?.role, "Custom role");
    assert.equal(updatedBeforeTerminal?.color, "#123456");
    assert.equal(updatedBeforeTerminal?.memoryNote, "custom");
    assert.deepEqual(updatedBeforeTerminal?.skills, ["local-skill"]);
    assert.equal(profileList.value.some((profile) => profile.id === "delete"), true);

    await loadMoreProfiles();
    assert.equal(profileList.value.length, 103);
    assert.deepEqual(profileList.value.slice(-3).map((profile) => profile.id), ["update", "draft-profile", "new"]);
    assert.equal(profileList.value.some((profile) => profile.id === "delete"), false);
    assert.equal(profileList.value.find((profile) => profile.id === "draft-profile")?.role, "Draft owner");
    assert.equal(sessions.value.some((session) => session.id === "local-draft"), true);
    assert.equal(selectedProfileId.value, "p0");
  } finally {
    browser.restore();
  }
});

test("partial terminal inventory preserves LKG until a later complete generation", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55203";
  const pages = [
    profilePage([], { ...continuing(0, "partial-final"), truncated: true, partialFailures: 1 }),
    profilePage([], terminal(0)),
    profilePage([], terminal(0))
  ];
  globalThis.fetch = inventoryFetch(pages);
  profileList.value = [profile("p0"), profile("stale")];
  sessions.value = [];

  try {
    const partial = snapshot({ profiles: [{ id: "p0", name: "P0", activity: "idle", activeSessionCount: 0 }], profilePage: continuing(1, "partial-next") });
    applyOfficeSnapshot(partial, serverUrl);
    initializeInventory(partial, identity(serverUrl, 20));
    await loadMoreProfiles();
    await loadMoreProfiles();
    assert.equal(profileList.value.some((profile) => profile.id === "stale"), true);

    const recovered = snapshot({ profiles: [{ id: "p0", name: "P0", activity: "idle", activeSessionCount: 0 }], profilePage: continuing(1, "recovered-next"), sequence: 2 });
    applyOfficeSnapshot(recovered, serverUrl);
    initializeInventory(recovered, identity(serverUrl, 21));
    await loadMoreProfiles();
    assert.equal(profileList.value.some((profile) => profile.id === "stale"), false);
  } finally {
    browser.restore();
  }
});

test("a failed continuation never prunes last-known-good extras", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55205";
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "9123456789abcdef" });
    if (path === "/api/v1/inventory") return json({}, 500);
    return json({}, 404);
  };
  profileList.value = [profile("p0"), profile("lkg")];
  sessions.value = [];

  try {
    const failed = snapshot({ profiles: [{ id: "p0", name: "P0", activity: "idle", activeSessionCount: 0 }], profilePage: continuing(1, "failed-next") });
    applyOfficeSnapshot(failed, serverUrl);
    initializeInventory(failed, identity(serverUrl, 25));
    await loadMoreProfiles();
    assert.equal(profileList.value.some((profile) => profile.id === "lkg"), true);
  } finally {
    browser.restore();
  }
});

test("a deferred terminal from an older generation cannot prune the newer generation", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55204";
  const oldPage = deferred<Response>();
  let inventoryCalls = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "7123456789abcdef" });
    if (path === "/api/v1/inventory") {
      inventoryCalls += 1;
      return inventoryCalls === 1 ? await oldPage.promise : json(sessionPage([], terminal(0)));
    }
    return json({}, 404);
  };
  const staleId = storedSessionClientId("p0", "stale");
  profileList.value = [profile("p0")];
  sessions.value = [storedClient("p0", "stale", "Stale")];

  try {
    initializeInventory(snapshot({ sessionPage: continuing(0, "old-next") }), identity(serverUrl, 30));
    const oldLoad = loadMoreSessions();
    await until(() => inventoryCalls === 1);
    initializeInventory(snapshot({ sessionPage: continuing(0, "new-next"), sequence: 2 }), identity(serverUrl, 31));
    oldPage.resolve(json(sessionPage([], terminal(0))));
    await oldLoad;
    assert.equal(sessions.value.some((session) => session.id === staleId), true);

    await loadMoreSessions();
    assert.equal(sessions.value.some((session) => session.id === staleId), false);
  } finally {
    browser.restore();
  }
});

function snapshot(options: {
  profiles?: OfficeSnapshotProfile[];
  sessions?: OfficeSnapshot["sessions"];
  profilePage?: OfficeInventoryPagination;
  sessionPage?: OfficeInventoryPagination;
  sequence?: number;
} = {}): OfficeSnapshot {
  const profiles = options.profiles ?? [{ id: "p0", name: "P0", activity: "idle", activeSessionCount: 0 }];
  const storedSessions = options.sessions ?? [];
  return {
    generatedAt: new Date(options.sequence ?? 1).toISOString(), sequence: options.sequence ?? 1,
    capabilities: { protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" }, access: { deviceId: "local", tier: "owner", exposure: "loopback", authentication: "local-cookie", allowedOperations: ["state.read"] }, features: ["chat", "profiles"] },
    profiles, sessions: storedSessions,
    inventory: { profiles: options.profilePage ?? terminal(profiles.length), sessions: options.sessionPage ?? terminal(storedSessions.length) },
    boards: []
  };
}

function profile(id: string): Profile {
  return { id, name: id, role: "", status: "idle", color: "#64b7a7", sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [] };
}

function stored(profileId: string, id: string, title = id, activity = "idle") {
  return { id, profileId, title, activity };
}

function storedClient(profileId: string, id: string, title: string, extra: Partial<ChatSession> = {}): ChatSession {
  return { id: storedSessionClientId(profileId, id), storedSessionId: id, profileId, title, status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "unloaded", ...extra };
}

function profilePage(rows: OfficeSnapshotProfile[], pagination: OfficeInventoryPagination) {
  return { kind: "profiles" as const, profiles: rows, sessions: [], pagination };
}

function sessionPage(rows: OfficeSnapshot["sessions"], pagination: OfficeInventoryPagination) {
  return { kind: "sessions" as const, profiles: [], sessions: rows, pagination };
}

function terminal(returned: number): OfficeInventoryPagination {
  return { returned, available: returned, total: returned, hasMore: false, truncated: false, partialFailures: 0 };
}

function continuing(returned: number, nextCursor: string): OfficeInventoryPagination {
  return { returned, available: returned + 1, total: returned + 1, hasMore: true, truncated: false, partialFailures: 0, nextCursor };
}

function identity(serverUrl: string, requestGeneration: number): OfficeSnapshotRequestIdentity {
  return { serverUrl, connectionGeneration: 1, requestGeneration };
}

function inventoryFetch(pages: unknown[]): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "8123456789abcdef" });
    if (path === "/api/v1/inventory") return json(pages.shift() ?? {});
    return json({}, 404);
  };
}

function registerRuntime(released: string[]): void {
  registerChatRuntime({
    ensureSession() {},
    releaseSession(sessionId) { released.push(sessionId); },
    submitPrompt() {}, interrupt() {},
    async respondClarify() {}, async respondApproval() {}
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("request did not reach expected state");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function installBrowserGlobals(): { restore(): void } {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1" } });
  return { restore() {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
  } };
}
