import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeSnapshot, OfficeSnapshotRequestIdentity } from "../src/domain.ts";
import { initializeInventory, loadMoreSessions, registerInventorySnapshotRefresh, sessionInventoryState } from "../src/inventory.ts";
import { localizeRuntimeMessage } from "../src/i18n.ts";
import { authenticateRemoteDevice, connectOfficeApi, logoutRemoteDevice } from "../src/office-api.ts";
import { applyOfficeSnapshot, officeSnapshot, sessions } from "../src/store.ts";

test("a newer snapshot commits before an older deferred request and cannot be overwritten", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55101";
  const healthRequests: Deferred<Response>[] = [];
  const snapshotRequests: Deferred<Response>[] = [];
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "0123456789abcdef" });
    if (path === "/api/v1/health") {
      const request = deferred<Response>();
      healthRequests.push(request);
      return await request.promise;
    }
    if (path === "/api/v1/snapshot") {
      const request = deferred<Response>();
      snapshotRequests.push(request);
      return await request.promise;
    }
    return json({}, 404);
  };

  const committed: number[] = [];
  let latestIdentity: OfficeSnapshotRequestIdentity | undefined;
  const connection = connectOfficeApi({
    onConnecting() {},
    onSnapshot(snapshot, identity) {
      if (!applyOfficeSnapshot(snapshot, identity)) return;
      initializeInventory(snapshot, identity);
      committed.push(snapshot.sequence);
      latestIdentity = identity;
    },
    onEventStream() {},
    onError(message) { assert.fail(message); }
  }, serverUrl);

  try {
    await until(() => healthRequests.length === 1);
    connection.retry();
    await until(() => healthRequests.length === 2);

    healthRequests[1]!.resolve(json({ ok: true, protocolVersion: 1, runtime: "ready" }));
    await until(() => snapshotRequests.length === 1);
    snapshotRequests[0]!.resolve(json(snapshot("new", 2)));
    await until(() => committed.length === 1);

    healthRequests[0]!.resolve(json({ ok: true, protocolVersion: 1, runtime: "ready" }));
    await until(() => snapshotRequests.length === 2);
    snapshotRequests[1]!.resolve(json(snapshot("old", 1)));
    await tick();

    assert.deepEqual(committed, [2]);
    assert.equal(officeSnapshot.value?.sequence, 2);
    assert.equal(officeSnapshot.value?.profiles[0]?.id, "new");

    const olderRefresh = connection.refresh();
    const newerRefresh = connection.refresh();
    await until(() => healthRequests.length === 4);
    healthRequests[3]!.resolve(json({ ok: true, protocolVersion: 1, runtime: "ready" }));
    await until(() => snapshotRequests.length === 3);
    snapshotRequests[2]!.resolve(json(snapshot("newest-request", 4)));
    await until(() => committed.length === 2);
    healthRequests[2]!.resolve(json({ ok: true, protocolVersion: 1, runtime: "ready" }));
    await until(() => snapshotRequests.length === 4);
    snapshotRequests[3]!.resolve(json(snapshot("older-request", 3)));
    await Promise.all([olderRefresh, newerRefresh]);

    assert.deepEqual(committed, [2, 4]);
    assert.equal(officeSnapshot.value?.profiles[0]?.id, "newest-request");
    assert.ok(latestIdentity);
    assert.equal(applyOfficeSnapshot(snapshot("store-rejected", 5), { ...latestIdentity, requestGeneration: latestIdentity.requestGeneration - 1 }), false);
    assert.equal(officeSnapshot.value?.profiles[0]?.id, "newest-request");
  } finally {
    connection.stop();
    browser.restore();
  }
});

test("an old inventory page cannot merge after a newer snapshot or login generation", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55102";
  const page = deferred<Response>();
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "1123456789abcdef" });
    if (path === "/api/v1/inventory") return await page.promise;
    return json({}, 404);
  };
  const beforeLogin = identity(serverUrl, 20, 1);
  const afterLogin = identity(serverUrl, 21, 1);
  sessions.value = [];

  try {
    initializeInventory(snapshot("before", 1, "old-cursor"), beforeLogin);
    const pending = loadMoreSessions();
    await until(() => sessionInventoryState.value.loading);
    initializeInventory(snapshot("after", 2, "new-cursor"), afterLogin);
    page.resolve(json(inventoryPage("stale-row")));
    await pending;

    assert.equal(sessions.value.some((session) => session.storedSessionId === "stale-row"), false);
    assert.equal(sessionInventoryState.value.nextCursor, "new-cursor");
    assert.equal(sessionInventoryState.value.loading, false);
  } finally {
    browser.restore();
  }
});

test("an old inventory page cannot cross a server URL change", async () => {
  const browser = installBrowserGlobals();
  const oldServerUrl = "http://127.0.0.1:55103";
  const newServerUrl = "http://127.0.0.1:55104";
  const page = deferred<Response>();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/auth/local") return json({ csrfToken: "2123456789abcdef" });
    if (url.pathname === "/api/v1/inventory" && url.origin === oldServerUrl) return await page.promise;
    return json({}, 404);
  };
  sessions.value = [];

  try {
    initializeInventory(snapshot("old-server", 1, "old-cursor"), identity(oldServerUrl, 30, 1));
    const pending = loadMoreSessions();
    await until(() => sessionInventoryState.value.loading);
    initializeInventory(snapshot("new-server", 2, "new-cursor"), identity(newServerUrl, 31, 1));
    page.resolve(json(inventoryPage("wrong-server-row")));
    await pending;

    assert.equal(sessions.value.some((session) => session.storedSessionId === "wrong-server-row"), false);
    assert.equal(sessionInventoryState.value.nextCursor, "new-cursor");
  } finally {
    browser.restore();
  }
});

test("logout and login invalidate cursor pages before their deferred responses commit", async () => {
  const browser = installBrowserGlobals();
  const logoutServer = "http://127.0.0.1:55108";
  const loginServer = "http://127.0.0.1:55109";
  const logoutPage = deferred<Response>();
  const loginPage = deferred<Response>();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/auth/local") return json({ csrfToken: `${url.port}123456789abcdef` });
    if (url.pathname === "/api/v1/auth/logout") return json({ ok: true });
    if (url.pathname === "/api/v1/auth/device") return json({ csrfToken: "6123456789abcdef" });
    if (url.pathname === "/api/v1/inventory" && url.origin === logoutServer) return await logoutPage.promise;
    if (url.pathname === "/api/v1/inventory" && url.origin === loginServer) return await loginPage.promise;
    assert.fail(`unexpected ${init?.method ?? "GET"} ${url}`);
  };
  sessions.value = [];

  try {
    initializeInventory(snapshot("logout", 1, "logout-cursor"), identity(logoutServer, 35, 1));
    const beforeLogout = loadMoreSessions();
    await until(() => sessionInventoryState.value.loading);
    await logoutRemoteDevice(logoutServer);
    logoutPage.resolve(json(inventoryPage("after-logout")));
    await beforeLogout;
    assert.equal(sessions.value.some((session) => session.storedSessionId === "after-logout"), false);

    initializeInventory(snapshot("login", 2, "login-cursor"), identity(loginServer, 36, 1));
    const beforeLogin = loadMoreSessions();
    await until(() => sessionInventoryState.value.loading);
    assert.deepEqual(await authenticateRemoteDevice("test-device", "credential", loginServer), { ok: true });
    loginPage.resolve(json(inventoryPage("after-login")));
    await beforeLogin;
    assert.equal(sessions.value.some((session) => session.storedSessionId === "after-login"), false);
    assert.equal(sessionInventoryState.value.hasMore, false);
    assert.equal(sessionInventoryState.value.loading, false);
  } finally {
    browser.restore();
  }
});

test("HTTP session recovery invalidates the pre-reauthentication inventory response", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55110";
  let authCalls = 0;
  let inventoryCalls = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") {
      authCalls += 1;
      return json({ csrfToken: `${authCalls}123456789abcdef` });
    }
    if (path === "/api/v1/inventory") {
      inventoryCalls += 1;
      return inventoryCalls === 1 ? json({}, 401) : json(inventoryPage("post-recovery-row"));
    }
    return json({}, 404);
  };
  sessions.value = [];

  try {
    initializeInventory(snapshot("recovery", 1, "recovery-cursor"), identity(serverUrl, 37, 1));
    await loadMoreSessions();

    assert.equal(authCalls, 2);
    assert.equal(inventoryCalls, 2);
    assert.equal(sessions.value.some((session) => session.storedSessionId === "post-recovery-row"), false);
    assert.equal(sessionInventoryState.value.hasMore, false);
    assert.equal(sessionInventoryState.value.loading, false);
  } finally {
    browser.restore();
  }
});

test("a delayed 409 recovery cannot replace a newer login snapshot", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55105";
  const recovery = deferred<OfficeSnapshotRequestIdentity | undefined>();
  let inventoryCalls = 0;
  let recoveryCalls = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "3123456789abcdef" });
    if (path === "/api/v1/inventory") { inventoryCalls += 1; return json({}, 409); }
    return json({}, 404);
  };
  registerInventorySnapshotRefresh(async () => {
    recoveryCalls += 1;
    return await recovery.promise;
  });

  try {
    initializeInventory(snapshot("old-login", 1, "stale-cursor"), identity(serverUrl, 40, 1));
    const pending = loadMoreSessions();
    await until(() => recoveryCalls === 1);
    initializeInventory(snapshot("new-login", 2, "current-cursor"), identity(serverUrl, 41, 1));
    recovery.resolve(identity(serverUrl, 40, 2));
    await pending;

    assert.equal(inventoryCalls, 1);
    assert.equal(sessionInventoryState.value.nextCursor, "current-cursor");
    assert.equal(sessionInventoryState.value.error, undefined);
  } finally {
    registerInventorySnapshotRefresh(undefined);
    browser.restore();
  }
});

test("a 409 recovery retries once within the refreshed inventory generation", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55107";
  let inventoryCalls = 0;
  let recoveryCalls = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "5123456789abcdef" });
    if (path === "/api/v1/inventory") { inventoryCalls += 1; return json({}, 409); }
    return json({}, 404);
  };
  registerInventorySnapshotRefresh(async () => {
    recoveryCalls += 1;
    const refreshed = identity(serverUrl, 60, 2);
    initializeInventory(snapshot("refreshed", 2, "fresh-cursor"), refreshed);
    return refreshed;
  });

  try {
    initializeInventory(snapshot("stale", 1, "stale-cursor"), identity(serverUrl, 60, 1));
    await loadMoreSessions();

    assert.equal(recoveryCalls, 1);
    assert.equal(inventoryCalls, 2);
    assert.equal(sessionInventoryState.value.hasMore, false);
    assert.equal(sessionInventoryState.value.loading, false);
    assert.match(sessionInventoryState.value.error ? localizeRuntimeMessage(sessionInventoryState.value.error) : "", /HTTP 409/);
  } finally {
    registerInventorySnapshotRefresh(undefined);
    browser.restore();
  }
});

test("concurrent load-more clicks issue one request and merge one page", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55106";
  const page = deferred<Response>();
  let inventoryCalls = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "4123456789abcdef" });
    if (path === "/api/v1/inventory") { inventoryCalls += 1; return await page.promise; }
    return json({}, 404);
  };
  sessions.value = [];

  try {
    initializeInventory(snapshot("multi", 1, "multi-cursor"), identity(serverUrl, 50, 1));
    const first = loadMoreSessions();
    const second = loadMoreSessions();
    await until(() => inventoryCalls === 1);
    page.resolve(json(inventoryPage("once-row")));
    await Promise.all([first, second]);

    assert.equal(inventoryCalls, 1);
    assert.equal(sessions.value.filter((session) => session.storedSessionId === "once-row").length, 1);
  } finally {
    browser.restore();
  }
});

function snapshot(profileId: string, sequence: number, cursor?: string): OfficeSnapshot {
  return {
    generatedAt: new Date(sequence).toISOString(), sequence,
    capabilities: { protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" }, access: { deviceId: "local", tier: "owner", exposure: "loopback", authentication: "local-cookie", allowedOperations: ["state.read"] }, features: ["chat", "profiles"] },
    profiles: [{ id: profileId, name: profileId, activity: "idle", activeSessionCount: 0 }], sessions: [],
    inventory: {
      profiles: { returned: 1, available: 1, total: 1, hasMore: false, truncated: false, partialFailures: 0 },
      sessions: cursor
        ? { returned: 0, available: 1, total: 1, hasMore: true, truncated: false, partialFailures: 0, nextCursor: cursor }
        : { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0 }
    },
    boards: []
  };
}

function inventoryPage(sessionId: string): unknown {
  return { kind: "sessions", profiles: [], sessions: [{ id: sessionId, profileId: "p1", title: sessionId, activity: "idle" }], pagination: { returned: 1, available: 1, total: 1, hasMore: false, truncated: false, partialFailures: 0 } };
}

function identity(serverUrl: string, connectionGeneration: number, requestGeneration: number): OfficeSnapshotRequestIdentity {
  return { serverUrl, connectionGeneration, requestGeneration };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  assert.fail("deferred request did not reach the expected state");
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function installBrowserGlobals(): { restore(): void } {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1" } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  return {
    restore() {
      globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: originalWebSocket });
    }
  };
}

class FakeWebSocket {
  addEventListener(): void {}
  close(): void {}
}
