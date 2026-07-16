import assert from "node:assert/strict";
import test from "node:test";
import type { ChatApiCallbacks, ChatHistoryResult, ChatTarget } from "../src/chat-api";
import { connectChatApi } from "../src/chat-api";
import { storedSessionClientId } from "../src/session-identity.ts";

test("delayed create from a four-pane eviction is closed and cannot resurrect the target", async () => {
  const harness = await createHarness();
  const targets = Array.from({ length: 5 }, (_, index): ChatTarget => ({
    clientSessionId: `client-${index + 1}`,
    profileId: `profile-${index + 1}`,
  }));
  for (const target of targets) harness.api.ensureSession(target);
  const staleCreate = harness.socket.frame("session.create", "profile-1");
  assert.ok(staleCreate);

  // The store evicts the oldest pane when the fifth target is opened.
  harness.api.releaseSession("client-1");
  harness.socket.respond(staleCreate.id, { session_id: "live-stale" });
  await flush();
  assert.equal(harness.ready.some((item) => item.clientSessionId === "client-1"), false);
  const staleClose = harness.socket.frame("session.close", "live-stale");
  assert.ok(staleClose);
  harness.socket.respond(staleClose.id, undefined, { code: -32000, message: "close failed" });

  harness.api.ensureSession(targets[0]!);
  const reopened = harness.socket.frames("session.create", "profile-1").at(-1)!;
  assert.notEqual(reopened.id, staleCreate.id);
  harness.socket.respond(reopened.id, { session_id: "live-current" });
  await flush();
  assert.deepEqual(harness.ready.filter((item) => item.clientSessionId === "client-1"), [
    { clientSessionId: "client-1", liveSessionId: "live-current" },
  ]);
  harness.api.stop();
});

test("delayed resume and history results are discarded after release", async () => {
  const history = deferred<unknown>();
  const harness = await createHarness(async <T>() => await history.promise as T);
  harness.api.ensureSession({ clientSessionId: "stored-client", profileId: "coder", storedSessionId: "stored-1" });
  const resume = harness.socket.frame("session.resume", "stored-1");
  assert.ok(resume);
  harness.api.releaseSession("stored-client");

  harness.socket.respond(resume.id, { session_id: "live-resumed", stored_session_id: "stored-1" });
  history.resolve({
    sessionId: "stored-1",
    messages: [{ index: 0, role: "assistant", text: "must be discarded" }],
    pagination: { hasMore: false, returned: 1 },
  });
  await flush();
  await flush();
  assert.equal(harness.ready.length, 0);
  assert.equal(harness.histories.length, 0);
  assert.ok(harness.socket.frame("session.close", "live-resumed"));
  harness.api.stop();
});

test("failed close keeps the tombstone and a same-id reopen gets a new generation", async () => {
  const harness = await createHarness();
  const target = { clientSessionId: "same-id", profileId: "builder" };
  harness.api.ensureSession(target);
  const create = harness.socket.frame("session.create", "builder")!;
  harness.socket.respond(create.id, { session_id: "live-old" });
  await flush();

  harness.api.releaseSession("same-id");
  const close = harness.socket.frame("session.close", "live-old")!;
  harness.socket.respond(close.id, undefined, { code: -32000, message: "temporary close failure" });
  harness.socket.event("live-old", "message.complete");
  harness.api.ensureSession(target);
  const reopen = harness.socket.frames("session.create", "builder").at(-1)!;
  harness.socket.respond(reopen.id, { session_id: "live-new" });
  await flush();

  assert.deepEqual(harness.ready.map((item) => item.liveSessionId), ["live-old", "live-new"]);
  assert.equal(harness.events.length, 0);
  harness.api.stop();
});

test("profile-scoped client IDs isolate resume, history, and events for equal stored IDs", async () => {
  const historyPaths: string[] = [];
  const harness = await createHarness(async <T>(path: string) => {
    historyPaths.push(path);
    return { sessionId: "shared-id", messages: [], pagination: { hasMore: false, returned: 0 } } as T;
  });
  const firstId = storedSessionClientId("p1", "shared-id");
  const secondId = storedSessionClientId("p2", "shared-id");
  harness.api.ensureSession({ clientSessionId: firstId, profileId: "p1", storedSessionId: "shared-id" });
  harness.api.ensureSession({ clientSessionId: secondId, profileId: "p2", storedSessionId: "shared-id" });
  await flush();

  const resumes = harness.socket.sent.filter((frame) => frame.method === "session.resume");
  assert.deepEqual(resumes.map((frame) => frame.params), [
    { session_id: "shared-id", profile: "p1" },
    { session_id: "shared-id", profile: "p2" },
  ]);
  assert.ok(historyPaths.some((path) => path.includes("profile=p1")));
  assert.ok(historyPaths.some((path) => path.includes("profile=p2")));
  harness.socket.respond(resumes[0]!.id, { session_id: "live-p1", stored_session_id: "shared-id" });
  harness.socket.respond(resumes[1]!.id, { session_id: "live-p2", stored_session_id: "shared-id" });
  await flush();
  harness.socket.event("live-p1", "message.complete");
  harness.socket.event("live-p2", "message.complete");
  assert.deepEqual(harness.events, [firstId, secondId]);
  harness.api.stop();
});

test("automatic history loading stops at the cumulative message boundary", async () => {
  let pages = 0;
  const harness = await createHarness(async <T>() => {
    const page = pages++;
    return {
      sessionId: "large-stored",
      messages: Array.from({ length: 25 }, (_, index) => ({ index: page * 25 + index, role: "assistant", text: `m-${page}-${index}` })),
      pagination: { hasMore: true, nextCursor: `cursor-${page + 1}`, returned: 25, truncated: false, partial: false },
    } as T;
  });
  harness.api.ensureSession({ clientSessionId: "large-client", profileId: "coder", storedSessionId: "large-stored" });
  await waitFor(() => harness.historyResults.length === 1);
  assert.equal(pages, 20);
  assert.deepEqual(harness.historyResults[0], { clientSessionId: "large-client", messages: 500, result: { truncated: true, partial: true, reason: "message_limit" } });
  harness.api.stop();
});

test("a later history page failure delivers prior pages as partial history", async () => {
  let pages = 0;
  const harness = await createHarness(async <T>() => {
    pages += 1;
    if (pages === 3) throw new Error("page three unavailable");
    return {
      sessionId: "partial-stored",
      messages: Array.from({ length: 2 }, (_, index) => ({ index: (pages - 1) * 2 + index, role: "assistant", text: `m-${pages}-${index}` })),
      pagination: { hasMore: true, nextCursor: `cursor-${pages}`, returned: 2, truncated: false, partial: false },
    } as T;
  });
  harness.api.ensureSession({ clientSessionId: "partial-client", profileId: "coder", storedSessionId: "partial-stored" });
  await waitFor(() => harness.historyResults.length === 1);
  assert.deepEqual(harness.historyResults[0], { clientSessionId: "partial-client", messages: 4, result: { truncated: true, partial: true, reason: "upstream_error" } });
  harness.api.stop();
});

async function createHarness(fetchJson?: <T>(path: string, options?: unknown, serverUrl?: string) => Promise<T>) {
  const socket = new FakeWebSocket();
  const ready: Array<{ clientSessionId: string; liveSessionId: string }> = [];
  const histories: string[] = [];
  const historyResults: Array<{ clientSessionId: string; messages: number; result: Pick<ChatHistoryResult, "truncated" | "partial" | "reason"> }> = [];
  const events: string[] = [];
  let sequence = 0;
  const callbacks: ChatApiCallbacks = {
    onSocketState() {}, onHistoryLoading() {}, onSessionConnecting() {}, onSessionDisconnected() {}, onSessionError() {}, onHistoryError() {},
    onHistory(clientSessionId, messages, _storedSessionId, result) { histories.push(clientSessionId); if (result) historyResults.push({ clientSessionId, messages: messages.length, result: { truncated: result.truncated, partial: result.partial, ...(result.reason ? { reason: result.reason } : {}) } }); },
    onSessionReady(clientSessionId, liveSessionId) { ready.push({ clientSessionId, liveSessionId }); },
    onEvent(clientSessionId) { events.push(clientSessionId); },
  };
  const api = connectChatApi(callbacks, {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => socket as unknown as WebSocket,
    ...(fetchJson === undefined ? {} : { fetchJson }),
    randomId: () => `rpc-${++sequence}`,
  });
  await flush();
  socket.open();
  await flush();
  return { api, socket, ready, histories, historyResults, events };
}

type RpcFrame = { id: string; method: string; params: Record<string, string> };

class FakeWebSocket {
  readyState = WebSocket.CONNECTING;
  readonly sent: RpcFrame[] = [];
  readonly #listeners = new Map<string, Set<(event: { data?: string; code?: number; reason?: string }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string; code?: number; reason?: string }) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(body: string): void { this.sent.push(JSON.parse(body) as RpcFrame); }
  close(code = 1000, reason = ""): void { this.readyState = WebSocket.CLOSED; this.#emit("close", { code, reason }); }
  open(): void { this.readyState = WebSocket.OPEN; this.#emit("open", {}); }
  respond(id: string, result?: unknown, error?: unknown): void {
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) }) });
  }
  event(liveSessionId: string, type: string): void {
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { session_id: liveSessionId, type, payload: {} } }) });
  }
  frame(method: string, value: string): RpcFrame | undefined { return this.frames(method, value)[0]; }
  frames(method: string, value: string): RpcFrame[] {
    return this.sent.filter((frame) => frame.method === method && Object.values(frame.params).includes(value));
  }
  #emit(type: string, event: { data?: string; code?: number; reason?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function waitFor(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await flush(); } throw new Error("Timed out waiting for chat history"); }
