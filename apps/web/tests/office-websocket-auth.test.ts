import assert from "node:assert/strict";
import test from "node:test";
import {
  OfficeDeviceAuthRequiredError,
  authenticateRemoteDevice,
  connectOfficeApi,
  openOfficeWebSocket,
  recoverOfficeWebSocketAuthentication,
  shouldRecoverOfficeWebSocket,
} from "../src/office-api.ts";
import { connectChatApi } from "../src/chat-api.ts";

test("simultaneous live event and chat expiry renew once and reconnect both transports", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example", fastTimers: true }, async () => {
    const serverUrl = "https://office.example";
    let localBootstraps = 0;
    let renewals = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "e".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) { localBootstraps += 1; return new Response(null, { status: 403 }); }
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return jsonResponse({ csrfToken: "f".repeat(32) }); }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) return jsonResponse(snapshot());
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const eventStates: string[] = [];
    const chatStates: string[] = [];
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const office = connectOfficeApi({
        onConnecting() {}, onSnapshot() {}, onError(message) { throw new Error(message); },
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

      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 2 && BareWebSocket.byPath("/api/v1/chat").length === 2);
      BareWebSocket.byPath("/api/v1/events")[1]!.open();
      BareWebSocket.byPath("/api/v1/chat")[1]!.open();
      assert.equal(localBootstraps, 1);
      assert.equal(renewals, 1);
      assert.equal(eventStates.filter((state) => state === "open").length, 2);
      assert.equal(chatStates.filter((state) => state === "ready").length, 2);
      chat.stop();
      office.stop();
    } finally {
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

test("revoked and rate-limited renewal fail closed through one shared attempt", async () => {
  for (const renewalStatus of [401, 429]) {
    await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
      const serverUrl = `https://office.example/failed-renew-${renewalStatus}`;
      let renewals = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "c".repeat(32) });
        if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
        if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return new Response(null, { status: renewalStatus }); }
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

test("desktop capability recovery remains cookie-free and does not call HTTP auth", async () => {
  await withBrowserEnvironment({ protocol: "tauri:", hostname: "tauri.localhost", origin: "tauri://localhost", desktopCapability: "d".repeat(48) }, async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; throw new Error("Desktop auth must not use fetch"); }) as typeof fetch;
    try {
      const serverUrl = "http://127.0.0.1:4317/desktop-recovery";
      const lease = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      await recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision);
      const recovered = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/chat", serverUrl);
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

type BrowserLocation = { protocol: string; hostname: string; origin: string; desktopCapability?: string; fastTimers?: boolean };

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
    setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, locationValue.fastTimers ? Math.min(timeout ?? 0, 1) : timeout),
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

function snapshot(): unknown {
  return {
    generatedAt: new Date(0).toISOString(), sequence: 1,
    capabilities: {
      protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" },
      access: { deviceId: "device-test", tier: "operator", exposure: "public", authentication: "device-cookie", allowedOperations: ["state.read"] },
      features: ["chat", "profiles"],
    },
    profiles: [], sessions: [], boards: [],
    inventory: {
      profiles: { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0 },
      sessions: { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0 },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for Office WebSocket state");
}
