import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesChatTransportError, type HermesChatEvent, type HermesChatRequest, type HermesChatResult } from "./hermes-chat.js";
import { ChatDeviceRateLimiter, handleOfficeChatConnection } from "./chat-gateway.js";
import { ChatSessionCoordinator } from "./chat-session-coordinator.js";
import { ChatUpstreamHub } from "./chat-upstream-hub.js";
import { OfficeAuth, type OfficeAuthSession } from "./office-auth.js";

const SESSION: OfficeAuthSession = {
  principal: { id: "close-settlement", tier: "operator", local: false, deviceName: "Close settlement" },
  csrfToken: "c".repeat(32), expiresAt: "2099-01-01T00:00:00.000Z",
};

for (const closedValue of [true, false]) {
  test(`disconnect cleanup joins an authoritative closed:${closedValue} close without resetting peers`, async () => {
    const hermes = new CloseSettlementFakeHermes({ closedValue });
    const closeGate = deferred<void>();
    hermes.delayFirstSessionClose(closeGate.promise);
    const { coordinator, hub, dependencies } = setup(hermes);
    const owner = new FakeWebSocket();
    const peer = new FakeWebSocket();
    handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
    handleOfficeChatConnection(peer as unknown as WebSocket, dependencies);
    await settle(4);
    owner.rpc(1, "session.resume", { session_id: "owner", profile: "coder" });
    peer.rpc(2, "session.resume", { session_id: "peer", profile: "reviewer" });
    await settle(6);

    owner.rpc(3, "session.close", { session_id: "live-owner" });
    await settle(2);
    assert.deepEqual(hermes.sessionCloseRequests, ["live-owner"]);
    owner.close(1006, "network lost while close was pending");
    let historyStarted = false;
    const history = hub.readStableHistory(async () => { historyStarted = true; return "stable"; });
    const replacement = new FakeWebSocket();
    handleOfficeChatConnection(replacement as unknown as WebSocket, dependencies);
    hermes.emit("live-peer", "peer remains live while owner close settles");
    await settle(5);

    assert.equal(historyStarted, false);
    assert.equal(replacement.hasMethod("office.ready"), false);
    assert.equal(peer.events("live-peer").at(-1)?.payload?.text, "peer remains live while owner close settles");
    assert.equal(peer.closed, undefined);
    assert.equal(hermes.connectionCloseCount, 0);

    closeGate.resolve();
    assert.equal(await history, "stable");
    await settle(10);
    assert.equal(replacement.hasMethod("office.ready"), true);
    assert.equal(coordinator.ownerForLive("live-owner"), undefined);
    assert.ok(coordinator.ownerForLive("live-peer"));
    assert.equal(hermes.connectionCloseCount, 0);
    assert.deepEqual(hermes.sessionCloseRequests, ["live-owner"], "cleanup joins rather than duplicating the successful close");
    hermes.emit("live-peer", "peer still routed after close settlement");
    await settle();
    assert.equal(peer.events("live-peer").at(-1)?.payload?.text, "peer still routed after close settlement");
  });
}

test("a joined close failure retries owner-locally, then resets peers behind history and readiness barriers", async () => {
  const hermes = new CloseSettlementFakeHermes({ failSessionClose: true });
  const closeGate = deferred<void>();
  const resetGate = deferred<void>();
  hermes.delayFirstSessionClose(closeGate.promise);
  hermes.delayConnectionClose(resetGate.promise);
  const { coordinator, hub, dependencies } = setup(hermes);
  const owner = new FakeWebSocket();
  const peer = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(peer as unknown as WebSocket, dependencies);
  await settle(4);
  owner.rpc(10, "session.resume", { session_id: "owner", profile: "coder" });
  peer.rpc(11, "session.resume", { session_id: "peer", profile: "reviewer" });
  await settle(6);

  owner.rpc(12, "session.close", { session_id: "live-owner" });
  await settle(2);
  owner.close(1006, "network lost while close was pending");
  let historyStarted = false;
  const history = hub.readStableHistory(async () => { historyStarted = true; return "after-reset"; });
  const replacement = new FakeWebSocket();
  handleOfficeChatConnection(replacement as unknown as WebSocket, dependencies);
  closeGate.resolve();
  await waitFor(() => hermes.sessionCloseRequests.length === 4 && hermes.connectionCloseCount === 1);

  assert.equal(peer.events("live-peer").at(-1)?.payload?.status, "resync_required");
  assert.equal(peer.closed?.code, 1013);
  assert.equal(historyStarted, false);
  assert.equal(replacement.hasMethod("office.ready"), false);
  assert.equal(coordinator.ownerForLive("live-peer"), undefined);

  resetGate.resolve();
  assert.equal(await history, "after-reset");
  await settle(8);
  assert.equal(replacement.hasMethod("office.ready"), false, "a socket fenced by the reset cannot become ready later");
  const recovered = new FakeWebSocket();
  handleOfficeChatConnection(recovered as unknown as WebSocket, dependencies);
  await settle(8);
  assert.equal(recovered.hasMethod("office.ready"), true);
});

function setup(hermes: CloseSettlementFakeHermes) {
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  return {
    coordinator,
    hub,
    dependencies: {
      auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
      maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
      sessionCoordinator: coordinator, chatHub: hub,
    },
  };
}

class CloseSettlementFakeHermes {
  readonly sessionCloseRequests: string[] = [];
  connectionCloseCount = 0;
  readonly #closedValue: boolean;
  readonly #failSessionClose: boolean;
  readonly #live = new Set<string>();
  #onEvent: ((event: HermesChatEvent) => void) | undefined;
  #firstSessionCloseGate: Promise<void> | undefined;
  #connectionCloseGate: Promise<void> | undefined;
  #connectionClosed = false;

  constructor(options: { closedValue?: boolean; failSessionClose?: boolean }) {
    this.#closedValue = options.closedValue ?? true;
    this.#failSessionClose = options.failSessionClose ?? false;
  }

  runtime(): HermesRuntimeSource {
    return {
      chat: () => ({
        connect: async (onEvent: (event: HermesChatEvent) => void) => {
          this.#onEvent = onEvent;
          this.#connectionClosed = false;
          return {
            get closed() { return false; },
            request: async (request: HermesChatRequest) => await this.#request(request),
            close: async () => {
              this.connectionCloseCount += 1;
              const gate = this.#connectionCloseGate;
              this.#connectionCloseGate = undefined;
              await gate;
              this.#connectionClosed = true;
              this.#live.clear();
            },
          };
        },
        inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
        fetchHistory: async () => { throw new Error("unused"); },
      }),
    } as unknown as HermesRuntimeSource;
  }

  delayFirstSessionClose(gate: Promise<void>): void { this.#firstSessionCloseGate = gate; }
  delayConnectionClose(gate: Promise<void>): void { this.#connectionCloseGate = gate; }
  emit(liveSessionId: string, text: string): void {
    this.#onEvent?.({ type: "message.delta", sessionId: liveSessionId, payload: { text } });
  }

  async #request(request: HermesChatRequest): Promise<HermesChatResult> {
    if (this.#connectionClosed) throw new Error("generation closed");
    if (request.method === "session.resume") {
      const storedId = String(request.params?.session_id);
      const liveSessionId = `live-${storedId}`;
      this.#live.add(liveSessionId);
      return { method: request.method, value: { liveSessionId, storedSessionId: storedId, running: false } };
    }
    if (request.method === "session.close") {
      const liveSessionId = String(request.params?.session_id);
      this.sessionCloseRequests.push(liveSessionId);
      const gate = this.#firstSessionCloseGate;
      this.#firstSessionCloseGate = undefined;
      await gate;
      if (this.#failSessionClose) throw new HermesChatTransportError("timed_out", "fake close timeout");
      this.#live.delete(liveSessionId);
      return { method: request.method, value: { closed: this.#closedValue } };
    }
    return { method: request.method, value: { status: "ok" } };
  }
}

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed?: { code: number; reason: string };

  send(body: string, callback?: (error?: Error) => void): void { this.sent.push(body); callback?.(); }
  close(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  rpc(id: number, method: string, params: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })), false);
  }
  hasMethod(method: string): boolean { return this.frames().some((frame) => frame.method === method); }
  events(liveSessionId: string): Array<{ payload?: Record<string, unknown> }> {
    return this.frames().flatMap((frame) => {
      if (frame.method !== "event") return [];
      const params = frame.params as { sessionId?: string; session_id?: string; payload?: Record<string, unknown> } | undefined;
      if (params === undefined || (params.sessionId ?? params.session_id) !== liveSessionId) return [];
      return [{ ...(params.payload === undefined ? {} : { payload: params.payload }) }];
    });
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((body) => JSON.parse(body) as Record<string, unknown>);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await settle();
  }
  throw new Error("Condition was not reached.");
}
