import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import type { HermesChatEvent, HermesChatRequest } from "./hermes-chat.js";
import { ChatDeviceRateLimiter, handleOfficeChatConnection, serializeOfficeChatEvent } from "./chat-gateway.js";
import { OfficeAuth, type OfficeAuthSession } from "./office-auth.js";

const REMOTE_SESSION: OfficeAuthSession = {
  principal: { id: "device-test", tier: "operator", local: false, deviceName: "Test device" },
  csrfToken: "c".repeat(32), expiresAt: "2099-01-01T00:00:00.000Z",
};

test("event serialization truncates UTF-8 safely within the exact envelope budget", () => {
  const boundaryEvent: HermesChatEvent = { type: "message.complete", sessionId: "s-boundary", payload: { text: "境界🦊", role: "assistant" } };
  const exactBoundary = JSON.stringify({ jsonrpc: "2.0", method: "event", params: boundaryEvent });
  assert.equal(serializeOfficeChatEvent(boundaryEvent, Buffer.byteLength(exactBoundary)), exactBoundary);
  assert.ok(Buffer.byteLength(serializeOfficeChatEvent(boundaryEvent, Buffer.byteLength(exactBoundary) - 1)) <= Buffer.byteLength(exactBoundary) - 1);

  const event: HermesChatEvent = { type: "message.complete", sessionId: "s-1", payload: { text: "🦊日本語".repeat(2_000), role: "assistant" } };
  const body = serializeOfficeChatEvent(event, 1_024);
  assert.ok(Buffer.byteLength(body) <= 1_024);
  const parsed = JSON.parse(body) as { params: { type: string; payload: { text?: string; truncated?: boolean; role?: string } } };
  assert.equal(parsed.params.type, "message.complete");
  assert.equal(parsed.params.payload.truncated, true);
  assert.equal(parsed.params.payload.role, "assistant");
  assert.equal(parsed.params.payload.text?.includes("�"), false);

  const approval = serializeOfficeChatEvent({
    type: "approval.request", sessionId: "s-2",
    payload: { command: "実行🦊".repeat(2_000), description: "説明", choices: ["once", "deny"], allowPermanent: false },
  }, 1_024);
  const approvalPayload = (JSON.parse(approval) as { params: { payload: { choices: string[]; description: string; truncated: boolean } } }).params.payload;
  assert.deepEqual(approvalPayload.choices, ["once", "deny"]);
  assert.equal(approvalPayload.description, "説明");
  assert.equal(approvalPayload.truncated, true);
});

test("gateway delivers a bounded multibyte event instead of silently dropping it", async () => {
  let publish!: (event: HermesChatEvent) => void;
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: REMOTE_SESSION,
    runtimeSource: runtimeWithConnections((onEvent) => { publish = onEvent; return connection(); }),
    maxJsonBytes: 1_024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
  });
  await flush();
  publish({ type: "tool.progress", sessionId: "s-1", payload: { name: "browser", summary: "進捗🦊".repeat(2_000), status: "running" } });
  const eventBody = client.sent.at(-1)!;
  assert.ok(Buffer.byteLength(eventBody) <= 1_024);
  const event = JSON.parse(eventBody) as { method: string; params: { type: string; payload: { truncated?: boolean; status?: string } } };
  assert.equal(event.method, "event");
  assert.equal(event.params.type, "tool.progress");
  assert.equal(event.params.payload.status, "running");
  assert.equal(event.params.payload.truncated, true);
});

test("slow or failed chat clients are closed with a resynchronization policy", async () => {
  let publishSlow!: (event: HermesChatEvent) => void;
  const slow = new FakeWebSocket();
  handleOfficeChatConnection(slow as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: REMOTE_SESSION,
    runtimeSource: runtimeWithConnections((onEvent) => { publishSlow = onEvent; return connection(); }),
    maxJsonBytes: 1_024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    limits: { maxBufferedBytes: 512 },
  });
  await flush();
  slow.bufferedAmount = 1_000;
  publishSlow({ type: "status.update", sessionId: "slow-1", payload: { status: "running" } });
  assert.deepEqual(slow.closed, { code: 1013, reason: "Client too slow; reload history" });

  let publishFailed!: (event: HermesChatEvent) => void;
  const failed = new FakeWebSocket();
  handleOfficeChatConnection(failed as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: REMOTE_SESSION,
    runtimeSource: runtimeWithConnections((onEvent) => { publishFailed = onEvent; return connection(); }),
    maxJsonBytes: 1_024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
  });
  await flush();
  failed.sendError = new Error("socket write failed");
  publishFailed({ type: "status.update", sessionId: "failed-1", payload: { status: "running" } });
  assert.deepEqual(failed.closed, { code: 1013, reason: "Client too slow; reload history" });
});

test("approval and clarification remain exact-socket, one-shot, expiring, and disconnect-bounded", async () => {
  let now = 1_000;
  const callbacks: Array<(event: HermesChatEvent) => void> = [];
  const requests: HermesChatRequest[][] = [[], []];
  const closes = [0, 0];
  let connectionIndex = 0;
  const runtime = runtimeWithConnections((onEvent) => {
    const index = connectionIndex++;
    callbacks[index] = onEvent;
    return {
      closed: false,
      request: async (request: HermesChatRequest) => { requests[index]!.push(request); return { method: request.method, value: { status: "ok" } }; },
      close: async () => { closes[index]! += 1; },
    };
  });
  const auth = new OfficeAuth();
  const limiter = new ChatDeviceRateLimiter({ now: () => now, capacity: 100, ratePerSecond: 0 });
  const a = new FakeWebSocket();
  const b = new FakeWebSocket();
  const dependencies = { auth, officeSession: REMOTE_SESSION, runtimeSource: runtime, maxJsonBytes: 64 * 1024, deviceLimiter: limiter, now: () => now, limits: { approvalTtlMs: 50, socketRateCapacity: 100 } };
  handleOfficeChatConnection(a as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(b as unknown as WebSocket, dependencies);
  await flush();

  callbacks[0]!({ type: "approval.request", sessionId: "s-1", payload: { choices: ["once", "deny"], allowPermanent: false } });
  a.rpc(1, "approval.respond", { session_id: "s-1", choice: "once" });
  b.rpc(2, "approval.respond", { session_id: "s-1", choice: "once" });
  await flush();
  assert.deepEqual(requests.map((items) => items.map((item) => item.method)), [["approval.respond"], []]);
  assert.equal(b.errorCode(2), -32004);

  a.rpc(3, "approval.respond", { session_id: "s-1", choice: "once" });
  callbacks[0]!({ type: "approval.request", sessionId: "s-invalid", payload: { choices: ["once"], allowPermanent: false } });
  a.rpc(4, "approval.respond", { session_id: "s-invalid", choice: "deny" });
  callbacks[0]!({ type: "approval.request", sessionId: "s-permanent", payload: { choices: ["always"], allowPermanent: true } });
  a.rpc(5, "approval.respond", { session_id: "s-permanent", choice: "always" });
  callbacks[0]!({ type: "approval.request", sessionId: "s-expired", payload: { choices: ["once"], allowPermanent: false } });
  now += 51;
  a.rpc(6, "approval.respond", { session_id: "s-expired", choice: "once" });
  callbacks[0]!({ type: "clarify.request", sessionId: "s-1", payload: { requestId: "q-1", question: "Proceed?" } });
  b.rpc(7, "clarify.respond", { request_id: "q-1", answer: "yes" });
  a.rpc(8, "clarify.respond", { request_id: "q-1", answer: "yes" });
  a.rpc(9, "clarify.respond", { request_id: "q-1", answer: "again" });
  callbacks[0]!({ type: "clarify.request", sessionId: "s-1", payload: { requestId: "q-expired", question: "Late?" } });
  now += 51;
  a.rpc(10, "clarify.respond", { request_id: "q-expired", answer: "late" });
  await flush();
  for (const id of [3, 4, 5, 6, 7, 9, 10]) assert.ok(a.hasError(id) || b.hasError(id));
  assert.equal(requests[0]!.filter((item) => item.method === "clarify.respond").length, 1);
  a.emit("close");
  await flush();
  assert.equal(closes[0], 1);
  const requestsAfterDisconnect = requests[0]!.length;
  a.rpc(12, "session.interrupt", { session_id: "s-1" });
  await flush();
  assert.equal(requests[0]!.length, requestsAfterDisconnect);

  let localPublish!: (event: HermesChatEvent) => void;
  const localRequests: HermesChatRequest[] = [];
  const localClient = new FakeWebSocket();
  handleOfficeChatConnection(localClient as unknown as WebSocket, {
    auth,
    officeSession: { ...REMOTE_SESSION, principal: { id: "local-browser", tier: "owner", local: true, deviceName: "Local browser" } },
    runtimeSource: runtimeWithConnections((onEvent) => {
      localPublish = onEvent;
      return connection(async (request) => { localRequests.push(request); return { method: request.method, value: { status: "ok" } }; });
    }),
    maxJsonBytes: 64 * 1024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 10, ratePerSecond: 0 }),
  });
  await flush();
  localPublish({ type: "approval.request", sessionId: "s-local", payload: { choices: ["always"], allowPermanent: true } });
  localClient.rpc(11, "approval.respond", { session_id: "s-local", choice: "always" });
  await flush();
  assert.deepEqual(localRequests.map((request) => request.method), ["approval.respond"]);
});

test("approval and clarification claims are exclusive and recover only after timely upstream failure", async () => {
  let now = 1_000;
  let publish!: (event: HermesChatEvent) => void;
  const approvalFailure = deferred<never>();
  const clarificationFailure = deferred<never>();
  const expiredFailure = deferred<never>();
  const requests: HermesChatRequest[] = [];
  let attempt = 0;
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: REMOTE_SESSION,
    runtimeSource: runtimeWithConnections((onEvent) => {
      publish = onEvent;
      return connection(async (request) => {
        requests.push(request);
        attempt += 1;
        if (attempt === 1) return await approvalFailure.promise;
        if (attempt === 3) return await clarificationFailure.promise;
        if (attempt === 5) return await expiredFailure.promise;
        return { method: request.method, value: { status: "ok" } };
      });
    }),
    maxJsonBytes: 64 * 1024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    now: () => now,
    limits: { approvalTtlMs: 50, socketRateCapacity: 100 },
  });
  await flush();

  publish({ type: "approval.request", sessionId: "s-retry", payload: { choices: ["once"], allowPermanent: false } });
  client.rpc(20, "approval.respond", { session_id: "s-retry", choice: "once" });
  client.rpc(21, "approval.respond", { session_id: "s-retry", choice: "once" });
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(client.errorCode(21), -32004);
  approvalFailure.reject(new Error("temporary approval failure"));
  await flush();
  assert.equal(client.errorCode(20), -32000);
  client.rpc(22, "approval.respond", { session_id: "s-retry", choice: "once" });
  await flush();
  assert.equal(requests.length, 2);
  client.rpc(23, "approval.respond", { session_id: "s-retry", choice: "once" });
  await flush();
  assert.equal(client.errorCode(23), -32004);

  publish({ type: "clarify.request", sessionId: "s-retry", payload: { requestId: "q-retry", question: "Retry?" } });
  client.rpc(24, "clarify.respond", { request_id: "q-retry", answer: "yes" });
  client.rpc(25, "clarify.respond", { request_id: "q-retry", answer: "competing" });
  await flush();
  assert.equal(requests.length, 3);
  assert.equal(client.errorCode(25), -32004);
  clarificationFailure.reject(new Error("temporary clarification failure"));
  await flush();
  assert.equal(client.errorCode(24), -32000);
  client.rpc(26, "clarify.respond", { request_id: "q-retry", answer: "retry" });
  await flush();
  assert.equal(requests.length, 4);
  client.rpc(27, "clarify.respond", { request_id: "q-retry", answer: "again" });
  await flush();
  assert.equal(client.errorCode(27), -32004);

  publish({ type: "approval.request", sessionId: "s-failure-expired", payload: { choices: ["once"], allowPermanent: false } });
  client.rpc(28, "approval.respond", { session_id: "s-failure-expired", choice: "once" });
  await flush();
  assert.equal(requests.length, 5);
  now += 51;
  expiredFailure.reject(new Error("late failure"));
  await flush();
  client.rpc(29, "approval.respond", { session_id: "s-failure-expired", choice: "once" });
  await flush();
  assert.equal(requests.length, 5);
  assert.equal(client.errorCode(29), -32004);
});

test("a same-session approval arriving during a claim survives both success and failure of its predecessor", async () => {
  let publish!: (event: HermesChatEvent) => void;
  const firstSuccess = deferred<void>();
  const firstFailure = deferred<void>();
  const requests: HermesChatRequest[] = [];
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: REMOTE_SESSION,
    runtimeSource: runtimeWithConnections((onEvent) => {
      publish = onEvent;
      return connection(async (request) => {
        requests.push(request);
        if (requests.length === 1) await firstSuccess.promise;
        if (requests.length === 4) await firstFailure.promise;
        return { method: request.method, value: { status: "ok" } };
      });
    }),
    maxJsonBytes: 64 * 1024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
  });
  await flush();

  publish({ type: "approval.request", sessionId: "s-successor", payload: { choices: ["once"], allowPermanent: false } });
  client.rpc(40, "approval.respond", { session_id: "s-successor", choice: "once" });
  publish({ type: "approval.request", sessionId: "s-successor", payload: { choices: ["deny"], allowPermanent: false } });
  publish({ type: "approval.request", sessionId: "s-successor", payload: { choices: ["deny"], allowPermanent: false } });
  publish({ type: "approval.request", sessionId: "s-successor", payload: { choices: ["later"], allowPermanent: false } });
  const completedApprovalId = client.approvalId("s-successor");
  assert.equal(client.frames().filter((frame) => (frame.params as { type?: string } | undefined)?.type === "approval.request").length, 1);
  firstSuccess.resolve(undefined);
  await flush();
  client.rpc(48, "approval.respond", { session_id: "s-successor", approval_id: completedApprovalId, choice: "once" });
  await flush();
  assert.equal(client.errorCode(48), -32004);
  client.rpc(41, "approval.respond", { session_id: "s-successor", choice: "deny" });
  await flush();
  client.rpc(44, "approval.respond", { session_id: "s-successor", choice: "later" });
  await flush();
  assert.equal(requests.filter((request) => request.method === "approval.respond").length, 3);
  assert.equal(client.hasError(41), false);

  publish({ type: "approval.request", sessionId: "s-successor", payload: { choices: ["once"], allowPermanent: false } });
  client.rpc(42, "approval.respond", { session_id: "s-successor", choice: "once" });
  publish({ type: "approval.request", sessionId: "s-successor", payload: { choices: ["deny"], allowPermanent: false } });
  publish({ type: "approval.request", sessionId: "s-successor", payload: { choices: ["later"], allowPermanent: false } });
  firstFailure.reject(new Error("predecessor failed"));
  await flush();
  assert.equal(client.errorCode(42), -32000);
  client.rpc(45, "approval.respond", { session_id: "s-successor", choice: "once" });
  await flush();
  client.rpc(46, "approval.respond", { session_id: "s-successor", choice: "deny" });
  await flush();
  client.rpc(47, "approval.respond", { session_id: "s-successor", choice: "later" });
  await flush();
  assert.equal(requests.filter((request) => request.method === "approval.respond").length, 7);
  assert.equal(requests.some((request) => "approval_id" in (request.params ?? {})), false);
  assert.equal(client.hasError(47), false);
});

test("approval queue overflow is explicit and closes the socket", async () => {
  let publish!: (event: HermesChatEvent) => void;
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: REMOTE_SESSION,
    runtimeSource: runtimeWithConnections((onEvent) => { publish = onEvent; return connection(); }),
    maxJsonBytes: 64 * 1024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    limits: { maxApprovalQueue: 2 },
  });
  await flush();
  for (const command of ["A", "B", "C"]) publish({ type: "approval.request", sessionId: "s-overflow", payload: { command, choices: ["once"], allowPermanent: false } });
  assert.deepEqual(client.closed, { code: 1013, reason: "Approval queue overflow; reload history" });
  const error = client.frames().find((frame) => (frame.params as { type?: string } | undefined)?.type === "error");
  assert.equal((error?.params as { payload?: { status?: string } } | undefined)?.payload?.status, "resync_required");
});

test("a queued response received before its request stays stale at the same clock tick", async () => {
  let publish!: (event: HermesChatEvent) => void;
  const gates = Array.from({ length: 4 }, () => deferred<void>());
  const requests: HermesChatRequest[] = [];
  let interruptIndex = 0;
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: REMOTE_SESSION,
    runtimeSource: runtimeWithConnections((onEvent) => {
      publish = onEvent;
      return connection(async (request) => {
        requests.push(request);
        if (request.method === "session.interrupt") await gates[interruptIndex++]!.promise;
        return { method: request.method, value: { status: "ok" } };
      });
    }),
    maxJsonBytes: 64 * 1024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    now: () => 1_000,
    limits: { socketRateCapacity: 100 },
  });
  await flush();
  for (let id = 30; id < 34; id += 1) client.rpc(id, "session.interrupt", { session_id: "s-block" });
  client.rpc(34, "approval.respond", { session_id: "s-new", choice: "once" });
  publish({ type: "approval.request", sessionId: "s-new", payload: { choices: ["once"], allowPermanent: false } });
  for (const gate of gates) gate.resolve(undefined);
  await flush();
  assert.equal(client.errorCode(34), -32004);
  assert.equal(requests.filter((request) => request.method === "approval.respond").length, 0);

  client.rpc(35, "approval.respond", { session_id: "s-new", choice: "once" });
  await flush();
  assert.equal(requests.filter((request) => request.method === "approval.respond").length, 1);
});

test("queue, in-flight, socket rate, and shared device rate limits are deterministic", async () => {
  const auth = new OfficeAuth();
  const waiting = deferred<ReturnType<typeof connection>>();
  const queuedClient = new FakeWebSocket();
  handleOfficeChatConnection(queuedClient as unknown as WebSocket, {
    auth, officeSession: REMOTE_SESSION, runtimeSource: runtimeWithConnect(() => waiting.promise), maxJsonBytes: 64 * 1024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }), limits: { socketRateCapacity: 100 },
  });
  for (let index = 0; index < 17; index += 1) queuedClient.rpc(index, "session.interrupt", { session_id: "s-1" });
  assert.deepEqual(queuedClient.closed, { code: 1013, reason: "Chat queue is full" });

  const gates = Array.from({ length: 5 }, () => deferred<void>());
  let started = 0;
  const activeClient = new FakeWebSocket();
  handleOfficeChatConnection(activeClient as unknown as WebSocket, {
    auth, officeSession: REMOTE_SESSION,
    runtimeSource: runtimeWithConnect(async () => connection(async (request) => { const index = started++; await gates[index]!.promise; return { method: request.method, value: { status: "ok" } }; })),
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }), limits: { socketRateCapacity: 100 },
  });
  await flush();
  for (let index = 0; index < 5; index += 1) activeClient.rpc(index, "session.interrupt", { session_id: "s-1" });
  await flush();
  assert.equal(started, 4);
  gates[0]!.resolve(undefined);
  await flush();
  assert.equal(started, 5);

  const rateClient = new FakeWebSocket();
  handleOfficeChatConnection(rateClient as unknown as WebSocket, {
    auth, officeSession: REMOTE_SESSION, runtimeSource: runtimeWithConnect(async () => connection()), maxJsonBytes: 64 * 1024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }), limits: { socketRateCapacity: 2, socketRatePerSecond: 0 },
  });
  await flush();
  for (let index = 0; index < 3; index += 1) rateClient.rpc(index, "session.interrupt", { session_id: "s-1" });
  assert.equal(rateClient.closed?.reason, "Chat rate limit exceeded");

  let clock = 0;
  const sharedLimiter = new ChatDeviceRateLimiter({ now: () => clock, capacity: 2, ratePerSecond: 0 });
  const deviceA = new FakeWebSocket();
  const deviceB = new FakeWebSocket();
  for (const client of [deviceA, deviceB]) handleOfficeChatConnection(client as unknown as WebSocket, {
    auth, officeSession: REMOTE_SESSION, runtimeSource: runtimeWithConnect(async () => connection()), maxJsonBytes: 64 * 1024,
    deviceLimiter: sharedLimiter, limits: { socketRateCapacity: 10, socketRatePerSecond: 0 }, now: () => clock,
  });
  await flush();
  deviceA.rpc(1, "session.interrupt", { session_id: "s-1" });
  deviceB.rpc(2, "session.interrupt", { session_id: "s-1" });
  deviceA.rpc(3, "session.interrupt", { session_id: "s-1" });
  assert.equal(deviceA.closed?.reason, "Device chat rate limit exceeded");

  const deviceLimiter = new ChatDeviceRateLimiter({ now: () => clock, capacity: 2, ratePerSecond: 1 });
  assert.equal(deviceLimiter.consume("same-device"), true);
  assert.equal(deviceLimiter.consume("same-device"), true);
  assert.equal(deviceLimiter.consume("same-device"), false);
  clock = 1_000;
  assert.equal(deviceLimiter.consume("same-device"), true);
});

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed?: { code: number; reason: string };
  sendError?: Error;
  send(body: string, callback?: (error?: Error) => void): void { this.sent.push(body); callback?.(this.sendError); }
  close(code: number, reason: string): void { this.closed = { code, reason }; this.readyState = WebSocket.CLOSED; this.emit("close"); }
  rpc(id: number, method: string, params: Record<string, unknown>): void {
    const enriched = method === "approval.respond" && params.approval_id === undefined
      ? { ...params, approval_id: this.approvalId(typeof params.session_id === "string" ? params.session_id : "") }
      : params;
    this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: enriched })), false);
  }
  approvalId(sessionId: string): string {
    const events = this.frames().filter((frame) => frame.method === "event").map((frame) => frame.params as { sessionId?: string; type?: string; payload?: { approvalId?: string } });
    return [...events].reverse().find((event) => event.type === "approval.request" && event.sessionId === sessionId)?.payload?.approvalId ?? "";
  }
  errorCode(id: number): number | undefined { return (this.frames().find((frame) => frame.id === id)?.error as { code?: number } | undefined)?.code; }
  hasError(id: number): boolean { return this.errorCode(id) !== undefined; }
  frames(): Array<Record<string, unknown>> { return this.sent.map((body) => JSON.parse(body) as Record<string, unknown>); }
}

function runtimeWithConnections(factory: (onEvent: (event: HermesChatEvent) => void) => ReturnType<typeof connection>): HermesRuntimeSource { return runtimeWithConnect(async (onEvent) => factory(onEvent)); }
function runtimeWithConnect(connect: (onEvent: (event: HermesChatEvent) => void) => Promise<ReturnType<typeof connection>>): HermesRuntimeSource {
  return { chat: () => ({ connect, fetchHistory: async () => { throw new Error("unused"); } }) } as unknown as HermesRuntimeSource;
}
function connection(request: (request: HermesChatRequest) => Promise<{ method: HermesChatRequest["method"]; value: Record<string, string> }> = async (input) => ({ method: input.method, value: { status: "ok" } })) {
  return { closed: false, request, close: async () => undefined };
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
