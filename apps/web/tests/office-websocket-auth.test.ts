import assert from "node:assert/strict";
import test from "node:test";
import {
  OfficeDeviceAuthRequiredError,
  OfficeSessionUnavailableError,
  REMOTE_PROXY_CONFIGURATION_MESSAGE,
  authenticateRemoteDevice,
  connectOfficeApi,
  openOfficeWebSocket,
  recoverOfficeWebSocketAuthentication,
  shouldRecoverOfficeWebSocket,
} from "../src/office-api.ts";
import { connectChatApi } from "../src/chat-api.ts";
import { initializeInventory, loadMoreSessions, sessionInventoryState } from "../src/inventory.ts";
import { applyOfficeSnapshot, officeAccess, officeConnection, officeSnapshot, openSessionIds, reconnectChatSession, registerChatRuntime, registerOfficeRetry, requireDeviceLogin, retryOfficeServer, sessions, setOfficeAuthenticated, setOfficeError, setOfficeEventStream } from "../src/store.ts";

test("simultaneous live event and chat expiry renew once and reconnect both transports", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example", fastTimers: true }, async () => {
    const serverUrl = "https://office.example";
    let localBootstraps = 0;
    let renewals = 0;
    let snapshotCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "e".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) { localBootstraps += 1; return new Response(null, { status: 403 }); }
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return jsonResponse({ csrfToken: "f".repeat(32) }); }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) { snapshotCalls += 1; return jsonResponse(snapshot(snapshotCalls, 100, true)); }
      if (url.includes("/api/v1/inventory?")) return jsonResponse({ kind: "sessions", profiles: [], sessions: [{ id: "session-101", profileId: "profile", title: "Session 101", activity: "idle" }], pagination: { returned: 1, available: 101, total: 101, hasMore: false, truncated: false, partialFailures: 0 } });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const eventStates: string[] = [];
    const chatStates: string[] = [];
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const office = connectOfficeApi({
        onConnecting() {}, onSnapshot(value, identity) { if (applyOfficeSnapshot(value, identity)) initializeInventory(value, identity); }, onError(message) { throw new Error(message); },
        onEventStream(state) { eventStates.push(state); }, onAuthRequired() { throw new Error("unexpected auth failure"); },
      }, serverUrl);
      const chat = connectChatApi({
        onSocketState(state) { chatStates.push(state); },
        onHistoryLoading() {}, onHistory() {}, onHistoryError() {}, onSessionConnecting() {},
        onSessionReady() {}, onSessionDisconnected() {}, onSessionError() {}, onEvent() {},
      }, { serverUrl, reconnectDelay: () => 0 });

      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && BareWebSocket.byPath("/api/v1/chat").length === 1);
      const firstEvent = BareWebSocket.byPath("/api/v1/events")[0]!;
      const firstChat = BareWebSocket.byPath("/api/v1/chat")[0]!;
      firstEvent.open();
      firstChat.open();
      firstEvent.serverClose(1008, "Session expired");
      firstChat.serverClose(1008, "Session expired");

      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      BareWebSocket.byPath("/api/v1/events")[1]!.open();
      await waitFor(() => BareWebSocket.byPath("/api/v1/chat").length === 2);
      BareWebSocket.byPath("/api/v1/chat")[1]!.open();
      assert.equal(localBootstraps, 1);
      assert.equal(renewals, 1);
      await waitFor(() => snapshotCalls === 2 && sessionInventoryState.value.hasMore);
      assert.equal(officeSnapshot.value?.sequence, 2);
      await loadMoreSessions();
      assert.equal(sessions.value.some((session) => session.storedSessionId === "session-101"), true);
      assert.equal(eventStates.filter((state) => state === "open").length, 2);
      assert.equal(chatStates.filter((state) => state === "ready").length, 2);
      chat.stop();
      office.stop();
      sessions.value = [];
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("chat-pane retry waits through snapshot and event-open barriers before creating Chat WebSocket", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
    const serverUrl = "https://office.example/chat-coordinated-recovery";
    const recoverySnapshot = deferred<Response>();
    const eventStates: string[] = [];
    const chatStates: string[] = [];
    let proxyHealthy = false;
    let renewals = 0;
    let snapshots = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "1".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) {
        renewals += 1;
        return proxyHealthy ? jsonResponse({ csrfToken: "2".repeat(32) }) : new Response(null, { status: 403 });
      }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) {
        snapshots += 1;
        if (snapshots === 1) return jsonResponse(snapshot(1));
        return snapshots === 2 ? await recoverySnapshot.promise : jsonResponse(snapshot(snapshots));
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let office: ReturnType<typeof connectOfficeApi> | undefined;
    let chat: ReturnType<typeof connectChatApi> | undefined;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      office = connectOfficeApi({
        onConnecting() {},
        onSnapshot(value, identity) {
          if (!applyOfficeSnapshot(value, identity)) return;
          initializeInventory(value, identity);
          setOfficeAuthenticated(identity.serverUrl);
        },
        onEventStream(state) { eventStates.push(state); setOfficeEventStream(state); },
        onError(message) { throw new Error(message); },
        onRecoveryUnavailable(message, url) { setOfficeError(message, url, true); },
        onAuthRequired() { throw new Error("unexpected auth failure"); },
      }, serverUrl);
      chat = connectChatApi({
        onSocketState(state) { chatStates.push(state); },
        onHistoryLoading() {}, onHistory() {}, onHistoryError() {}, onSessionConnecting() {},
        onSessionReady() {}, onSessionDisconnected() {}, onSessionError() {}, onEvent() {},
      }, { serverUrl, reconnectDelay: () => 0 });
      sessions.value = [{ id: "chat-retry", profileId: "profile", title: "Retry", status: "ready", messages: [], remoteKind: "draft", connectionState: "connecting", historyState: "unloaded" }];
      openSessionIds.value = ["chat-retry"];
      registerChatRuntime(chat);

      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && BareWebSocket.byPath("/api/v1/chat").length === 1);
      BareWebSocket.byPath("/api/v1/events")[0]!.open();
      BareWebSocket.byPath("/api/v1/chat")[0]!.open();
      BareWebSocket.byPath("/api/v1/events")[0]!.serverClose(1008, "Session expired");
      BareWebSocket.byPath("/api/v1/chat")[0]!.serverClose(1008, "Session expired");
      await waitFor(() => renewals === 1 && officeConnection.value.state === "error" && chatStates.at(-1) === "error");

      proxyHealthy = true;
      reconnectChatSession("chat-retry");
      await waitFor(() => renewals === 2 && snapshots === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      assert.equal(BareWebSocket.byPath("/api/v1/events").length, 1);
      assert.equal(officeConnection.value.state, "error");
      assert.equal(officeConnection.value.eventStream, "connecting");

      recoverySnapshot.resolve(jsonResponse(snapshot(2)));
      await waitFor(() => officeSnapshot.value?.sequence === 2 && BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      BareWebSocket.byPath("/api/v1/events")[1]!.serverClose(1006, "event handshake failed");
      await waitFor(() => chatStates.filter((state) => state === "error").length === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);

      office.retry();
      await waitFor(() => snapshots === 3 && BareWebSocket.byPath("/api/v1/events").length === 3);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      BareWebSocket.byPath("/api/v1/events")[2]!.open();
      await waitFor(() => BareWebSocket.byPath("/api/v1/chat").length === 2);
      BareWebSocket.byPath("/api/v1/chat")[1]!.open();
      assert.equal(officeConnection.value.state, "connected");
      assert.equal(officeConnection.value.eventStream, "open");
      assert.equal(eventStates.filter((state) => state === "open").length, 2);
      assert.equal(chatStates.filter((state) => state === "ready").length, 2);
      assert.equal(renewals, 2);
      assert.equal(snapshots, 3);
    } finally {
      chat?.stop();
      office?.stop();
      sessions.value = [];
      openSessionIds.value = [];
      globalThis.fetch = originalFetch;
    }
  });
});

test("event-side retry keeps halted chat stopped until a failed recovery snapshot later succeeds", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
    const serverUrl = "https://office.example/event-coordinated-recovery";
    const chatStates: string[] = [];
    let proxyHealthy = false;
    let failSnapshot = true;
    let renewals = 0;
    let snapshots = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "3".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return proxyHealthy ? jsonResponse({ csrfToken: "4".repeat(32) }) : new Response(null, { status: 403 }); }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) { snapshots += 1; return snapshots > 1 && failSnapshot ? new Response(null, { status: 503 }) : jsonResponse(snapshot(snapshots)); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let office: ReturnType<typeof connectOfficeApi> | undefined;
    let chat: ReturnType<typeof connectChatApi> | undefined;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      office = connectOfficeApi({
        onConnecting() {}, onSnapshot(value, identity) { if (applyOfficeSnapshot(value, identity)) setOfficeAuthenticated(identity.serverUrl); },
        onEventStream: setOfficeEventStream, onError(message) { throw new Error(message); },
        onRecoveryUnavailable(message, url) { setOfficeError(message, url, true); }, onAuthRequired() { throw new Error("unexpected auth failure"); },
      }, serverUrl);
      chat = connectChatApi({
        onSocketState(state) { chatStates.push(state); }, onHistoryLoading() {}, onHistory() {}, onHistoryError() {},
        onSessionConnecting() {}, onSessionReady() {}, onSessionDisconnected() {}, onSessionError() {}, onEvent() {},
      }, { serverUrl, reconnectDelay: () => 0 });
      chat.ensureSession({ clientSessionId: "halted-target", profileId: "profile" });
      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && BareWebSocket.byPath("/api/v1/chat").length === 1);
      BareWebSocket.byPath("/api/v1/events")[0]!.open();
      BareWebSocket.byPath("/api/v1/chat")[0]!.open();
      BareWebSocket.byPath("/api/v1/events")[0]!.serverClose(1008, "Session expired");
      BareWebSocket.byPath("/api/v1/chat")[0]!.serverClose(1008, "Session expired");
      await waitFor(() => renewals === 1 && chatStates.at(-1) === "error");

      proxyHealthy = true;
      office.retry();
      await waitFor(() => renewals === 2 && snapshots === 2 && officeConnection.value.state === "error");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(BareWebSocket.byPath("/api/v1/events").length, 1);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      assert.equal(officeSnapshot.value?.sequence, 1);

      failSnapshot = false;
      office.retry();
      await waitFor(() => snapshots === 3 && BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      BareWebSocket.byPath("/api/v1/events")[1]!.open();
      await waitFor(() => BareWebSocket.byPath("/api/v1/chat").length === 2);
      assert.equal(renewals, 2);
    } finally {
      chat?.stop();
      office?.stop();
      globalThis.fetch = originalFetch;
    }
  });
});

test("event and chat expiry share one bounded remote device renewal", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
    const serverUrl = "https://office.example/shared-renew";
    let localBootstraps = 0;
    let renewals = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "a".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) { localBootstraps += 1; return new Response(null, { status: 403 }); }
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return jsonResponse({ csrfToken: "b".repeat(32) }); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const eventLease = await openOfficeWebSocket("wss://office.example/api/v1/events", serverUrl);
      const chatLease = await openOfficeWebSocket("wss://office.example/api/v1/chat", serverUrl);
      assert.equal(eventLease.authRevision, chatLease.authRevision);

      await Promise.all([
        recoverOfficeWebSocketAuthentication(serverUrl, eventLease.authRevision),
        recoverOfficeWebSocketAuthentication(serverUrl, chatLease.authRevision),
      ]);

      assert.equal(localBootstraps, 1);
      assert.equal(renewals, 1);
      const recovered = await openOfficeWebSocket("wss://office.example/api/v1/events", serverUrl);
      assert.notEqual(recovered.authRevision, eventLease.authRevision);
      assert.deepEqual(Object.keys(recovered).sort(), ["authRevision", "socket"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a failed post-renew snapshot preserves LKG and explicit retry restores pagination", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example", fastTimers: true }, async () => {
    const serverUrl = "https://office.example/recovery-snapshot";
    let snapshotCalls = 0;
    let failRecoverySnapshot = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "7".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) return jsonResponse({ csrfToken: "8".repeat(32) });
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) {
        snapshotCalls += 1;
        if (snapshotCalls === 2 && failRecoverySnapshot) return new Response(null, { status: 503 });
        return jsonResponse(snapshot(snapshotCalls, 100, true));
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const office = connectOfficeApi({
        onConnecting() {},
        onSnapshot(value, identity) { if (applyOfficeSnapshot(value, identity)) initializeInventory(value, identity); },
        onEventStream() {}, onError(message) { throw new Error(message); },
        onRecoveryUnavailable(message, url) { setOfficeError(message, url, true); },
        onAuthRequired() { throw new Error("unexpected auth failure"); },
      }, serverUrl);
      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && officeSnapshot.value?.sequence === 1);
      const firstEvent = BareWebSocket.byPath("/api/v1/events")[0]!;
      firstEvent.open();
      firstEvent.serverClose(1008, "Session expired");
      await waitFor(() => snapshotCalls === 2 && officeConnection.value.state === "error");
      assert.equal(officeSnapshot.value?.sequence, 1);
      assert.equal(sessions.value.length, 100);
      assert.equal(sessionInventoryState.value.hasMore, false);

      failRecoverySnapshot = false;
      office.retry();
      await waitFor(() => officeSnapshot.value?.sequence === 3 && sessionInventoryState.value.hasMore);
      assert.equal(sessions.value.length, 100);
      office.stop();
      sessions.value = [];
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("event recovery honors Retry-After, stays out of login, and snapshots after retry succeeds", async () => {
  const timerDelays: number[] = [];
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example", fastTimers: true, timerDelays }, async () => {
    const serverUrl = "https://office.example/rate-limited-recovery";
    let renewals = 0;
    let snapshots = 0;
    let authRequired = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "4".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) {
        renewals += 1;
        return renewals === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "60" } })
          : jsonResponse({ csrfToken: "5".repeat(32) });
      }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) { snapshots += 1; return jsonResponse(snapshot(snapshots)); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const office = connectOfficeApi({
        onConnecting() {}, onSnapshot() {}, onEventStream() {}, onError() {}, onRecoveryUnavailable() {},
        onAuthRequired() { authRequired += 1; },
      }, serverUrl);
      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1);
      BareWebSocket.byPath("/api/v1/events")[0]!.open();
      BareWebSocket.byPath("/api/v1/events")[0]!.serverClose(1008, "Session expired");
      await waitFor(() => renewals === 2 && snapshots === 2 && BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(timerDelays.includes(60_000), true);
      assert.equal(authRequired, 0);
      office.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("401 renewal requires login through one shared attempt", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
    const serverUrl = "https://office.example/revoked-renew";
    let renewals = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "c".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return new Response(null, { status: 401 }); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const lease = await openOfficeWebSocket("wss://office.example/api/v1/events", serverUrl);
      const results = await Promise.allSettled([
        recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision),
        recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision),
      ]);
      assert.equal(renewals, 1);
      assert.ok(results.every((result) => result.status === "rejected" && result.reason instanceof OfficeDeviceAuthRequiredError));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("renew 403 preserves LKG and waits for trusted proxy repair without device re-enrollment", async () => {
  const timerDelays: number[] = [];
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example", fastTimers: true, timerDelays }, async () => {
    const serverUrl = "https://office.example/proxy-repair";
    let enrollments = 0;
    let renewals = 0;
    let snapshots = 0;
    let proxyHealthy = false;
    let authRequired = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) { enrollments += 1; return jsonResponse({ csrfToken: "d".repeat(32) }); }
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) {
        renewals += 1;
        return proxyHealthy ? jsonResponse({ csrfToken: "e".repeat(32) }) : new Response(null, { status: 403 });
      }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) { snapshots += 1; return jsonResponse(snapshot(snapshots, 1)); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let office: ReturnType<typeof connectOfficeApi> | undefined;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      office = connectOfficeApi({
        onConnecting() {},
        onSnapshot(value, identity) {
          if (!applyOfficeSnapshot(value, identity)) return;
          initializeInventory(value, identity);
          setOfficeAuthenticated(identity.serverUrl);
        },
        onEventStream() {},
        onError(message) { throw new Error(message); },
        onRecoveryUnavailable(message, url) { setOfficeError(message, url, true); },
        onAuthRequired(url) { authRequired += 1; requireDeviceLogin(url); },
      }, serverUrl);
      registerOfficeRetry(() => office.retry());
      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && officeSnapshot.value?.sequence === 1);
      const reconnectTimersBeforeFailure = timerDelays.filter((delay) => delay >= 3_000).length;
      BareWebSocket.byPath("/api/v1/events")[0]!.open();
      BareWebSocket.byPath("/api/v1/events")[0]!.serverClose(1008, "Session expired");
      await waitFor(() => renewals === 1 && officeConnection.value.state === "error");
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(officeConnection.value.message, REMOTE_PROXY_CONFIGURATION_MESSAGE);
      assert.equal(officeAccess.value.state, "authenticated");
      assert.equal(officeSnapshot.value?.sequence, 1);
      assert.equal(sessions.value.length, 1);
      assert.equal(authRequired, 0);
      assert.equal(enrollments, 1);
      assert.equal(BareWebSocket.byPath("/api/v1/events").length, 1);
      assert.equal(timerDelays.filter((delay) => delay >= 3_000).length, reconnectTimersBeforeFailure);

      proxyHealthy = true;
      retryOfficeServer();
      await waitFor(() => renewals === 2 && officeSnapshot.value?.sequence === 2 && BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(officeAccess.value.state, "authenticated");
      assert.equal(enrollments, 1);
      assert.equal(authRequired, 0);
      sessions.value = [];
    } finally {
      office?.stop();
      registerOfficeRetry(() => {});
      globalThis.fetch = originalFetch;
    }
  });
});

test("network, timeout, 429, and 5xx renewal failures remain retryable", async () => {
  const cases: Array<{ name: string; response?: Response; failure?: Error; retryAfterMs: number }> = [
    { name: "network", failure: new TypeError("offline"), retryAfterMs: 0 },
    { name: "timeout", failure: new DOMException("timed out", "AbortError"), retryAfterMs: 0 },
    { name: "rate", response: new Response(null, { status: 429, headers: { "Retry-After": "60" } }), retryAfterMs: 60_000 },
    { name: "server", response: new Response(null, { status: 503 }), retryAfterMs: 0 },
  ];
  for (const item of cases) {
    await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
      const serverUrl = `https://office.example/retryable-${item.name}`;
      let renewals = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "9".repeat(32) });
        if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
        if (url.endsWith("/api/v1/auth/device/renew")) {
          renewals += 1;
          if (item.failure) throw item.failure;
          return item.response!;
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;
      try {
        assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
        const lease = await openOfficeWebSocket("wss://office.example/api/v1/events", serverUrl);
        const results = await Promise.allSettled([
          recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision),
          recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision),
        ]);
        assert.equal(renewals, 1);
        assert.ok(results.every((result) => result.status === "rejected" && result.reason instanceof OfficeSessionUnavailableError && result.reason.retryAfterMs === item.retryAfterMs));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test("local cookie recovery rotates locally without using the device endpoint", async () => {
  await withBrowserEnvironment({ protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:4317" }, async () => {
    const serverUrl = "http://127.0.0.1:4317/local-recovery";
    let localBootstraps = 0;
    let renewals = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/local")) {
        localBootstraps += 1;
        return jsonResponse({ csrfToken: String(localBootstraps).repeat(32) });
      }
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return new Response(null, { status: 500 }); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      const lease = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      await recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision);
      const recovered = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      assert.notEqual(recovered.authRevision, lease.authRevision);
      assert.equal(localBootstraps, 2);
      assert.equal(renewals, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("local bootstrap 5xx remains unavailable instead of requesting device login", async () => {
  await withBrowserEnvironment({ protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:4317" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    try {
      const result = await Promise.allSettled([openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", "http://127.0.0.1:4317/local-503")]);
      assert.equal(result[0]?.status, "rejected");
      if (result[0]?.status === "rejected") {
        assert.equal(result[0].reason instanceof OfficeSessionUnavailableError, true);
        assert.equal(result[0].reason instanceof OfficeDeviceAuthRequiredError, false);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("desktop capability recovery remains cookie-free and does not call HTTP auth", async () => {
  await withBrowserEnvironment({ protocol: "tauri:", hostname: "tauri.localhost", origin: "tauri://localhost", desktopCapability: "d".repeat(48) }, async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; throw new Error("Desktop auth must not use fetch"); }) as typeof fetch;
    try {
      const serverUrl = "http://127.0.0.1:4317/desktop-recovery";
      const lease = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      await recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision);
      const recovered = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      assert.notEqual(recovered.authRevision, lease.authRevision);
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("WebSocket auth-close classification excludes ordinary open transport loss", () => {
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1008, reason: "Session expired" }, true), true);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1008, reason: "Device revoked" }, true), true);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1006, reason: "" }, false), true);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1000, reason: "" }, false, true), true);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1006, reason: "network lost" }, true), false);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1013, reason: "Hermes runtime unavailable" }, true), false);
});

test("authenticated WebSocket leases reject cross-origin and non-Office targets before auth", async () => {
  await assert.rejects(openOfficeWebSocket("wss://attacker.example/api/v1/chat", "https://office.example"), /target is invalid/);
  await assert.rejects(openOfficeWebSocket("wss://office.example/private", "https://office.example"), /target is invalid/);
  await assert.rejects(openOfficeWebSocket("wss://office.example/api/v1/chat?leak=1", "https://office.example"), /target is invalid/);
});

type BrowserLocation = { protocol: string; hostname: string; origin: string; desktopCapability?: string; fastTimers?: boolean; timerDelays?: number[] };

async function withBrowserEnvironment(locationValue: BrowserLocation, run: () => Promise<void>): Promise<void> {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const bridge = locationValue.desktopCapability === undefined ? undefined : {
    invoke: async () => locationValue.desktopCapability!,
  };
  Object.defineProperty(globalThis, "location", { configurable: true, value: locationValue });
  const browserWindow = {
    __TAURI_INTERNALS__: bridge,
    setTimeout: (handler: TimerHandler, timeout?: number) => {
      locationValue.timerDelays?.push(timeout ?? 0);
      return globalThis.setTimeout(handler, locationValue.fastTimers ? Math.min(timeout ?? 0, 1) : timeout);
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
  };
  BareWebSocket.created.length = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: BareWebSocket });
  try {
    await run();
  } finally {
    restoreProperty("location", locationDescriptor);
    restoreProperty("window", windowDescriptor);
    restoreProperty("WebSocket", webSocketDescriptor);
  }
}

class BareWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly created: BareWebSocket[] = [];
  readyState = BareWebSocket.CONNECTING;
  readonly #listeners = new Map<string, Set<(event: Event | MessageEvent | CloseEvent) => void>>();
  #closed = false;

  constructor(readonly url: string, readonly protocols?: string | string[]) { BareWebSocket.created.push(this); }
  static byPath(path: string): BareWebSocket[] { return BareWebSocket.created.filter((socket) => new URL(socket.url).pathname === path); }
  addEventListener(type: string, listener: (event: Event | MessageEvent | CloseEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  send(): void {}
  open(): void { if (!this.#closed) { this.readyState = BareWebSocket.OPEN; this.#emit("open", new Event("open")); } }
  close(code = 1000, reason = ""): void { this.serverClose(code, reason); }
  serverClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = BareWebSocket.CLOSED;
    this.#emit("close", { code, reason } as CloseEvent);
  }
  #emit(type: string, event: Event | MessageEvent | CloseEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function restoreProperty(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function snapshot(sequence = 1, sessionCount = 0, hasMore = false): unknown {
  const snapshotSessions = Array.from({ length: sessionCount }, (_, index) => ({ id: `session-${index + 1}`, profileId: "profile", title: `Session ${index + 1}`, activity: "idle" }));
  return {
    generatedAt: new Date(sequence).toISOString(), sequence,
    capabilities: {
      protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" },
      access: { deviceId: "device-test", tier: "operator", exposure: "public", authentication: "device-cookie", allowedOperations: ["state.read"] },
      features: ["chat", "profiles"],
    },
    profiles: [{ id: "profile", name: "Profile", activity: "idle", activeSessionCount: sessionCount }], sessions: snapshotSessions, boards: [],
    inventory: {
      profiles: { returned: 1, available: 1, total: 1, hasMore: false, truncated: false, partialFailures: 0 },
      sessions: { returned: sessionCount, available: hasMore ? sessionCount + 1 : sessionCount, total: hasMore ? sessionCount + 1 : sessionCount, hasMore, truncated: false, partialFailures: 0, ...(hasMore ? { nextCursor: `cursor-${sequence}` } : {}) },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for Office WebSocket state");
}
