import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import type { HermesCanonicalSession, HermesChatEvent, HermesChatRequest } from "./hermes-chat.js";
import { ChatDeviceRateLimiter, handleOfficeChatConnection } from "./chat-gateway.js";
import { ChatSessionCoordinator } from "./chat-session-coordinator.js";
import { OfficeAuth, type OfficeAuthSession } from "./office-auth.js";

const OFFICE_SESSION: OfficeAuthSession = {
  principal: { id: "canonical-test", tier: "operator", local: false, deviceName: "Canonical test" },
  csrfToken: "c".repeat(32), expiresAt: "2099-01-01T00:00:00.000Z",
};

test("rotation aliases stay atomic across existing leases and release by the newest durable ID", () => {
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const first = coordinator.claimCreate(owner, "coder");
  const second = coordinator.claimCreate(owner, "coder");
  assert.equal(coordinator.bind(first, { liveSessionId: "live-a", storedSessionId: "tip-a" }, true), "bound");
  assert.equal(coordinator.bind(second, { liveSessionId: "live-b", storedSessionId: "tip-b" }, true), "bound");
  assert.equal(coordinator.bindLiveSessionAlias(owner, "live-a", "rotated-a"), "bound");
  assert.equal(coordinator.bindLiveSessionAlias(owner, "live-a", "tip-b"), "conflict");
  assert.equal(coordinator.releaseSession(owner, "rotated-a"), true);

  const nextOwner = {};
  const reclaimed = coordinator.claimResume(nextOwner, "coder", {
    requestedSessionId: "rotated-a", sessionId: "rotated-a", path: ["rotated-a"],
  });
  // The unrelated second lease is still active, so the resume remains
  // fail-closed across owners until that upstream transport is also gone.
  assert.equal(reclaimed, undefined);
  coordinator.releaseOwner(owner);
  assert.ok(coordinator.claimResume(nextOwner, "coder", {
    requestedSessionId: "rotated-a", sessionId: "rotated-a", path: ["rotated-a"],
  }));
});

test("canonical preflight prevents Hermes global rebind and disconnect reap across aliases and profiles", async () => {
  const hermes = new SideEffectfulFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const dependencies = {
    auth: new OfficeAuth(), officeSession: OFFICE_SESSION,
    runtimeSource: hermes.runtime(), maxJsonBytes: 64 * 1024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, limits: { socketRateCapacity: 100 },
  };

  const titleClient = new FakeWebSocket();
  handleOfficeChatConnection(titleClient as unknown as WebSocket, dependencies);
  await flush();
  titleClient.rpc(1, "session.resume", { session_id: "project-chat", profile: "coder" });
  await flush();
  assert.equal(titleClient.errorCode(1), -32000);
  assert.equal(hermes.resumeRequests.length, 0, "a title alias must never reach side-effectful session.resume");
  titleClient.close(1000, "title test complete");
  await flush();

  const a = new FakeWebSocket();
  const b = new FakeWebSocket();
  handleOfficeChatConnection(a as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(b as unknown as WebSocket, dependencies);
  await flush();

  a.rpc(10, "session.resume", { session_id: "ancestor-1", profile: "coder" });
  await flush();
  assert.equal(a.errorCode(10), undefined);
  assert.deepEqual(hermes.resumeRequests, [{ transportId: 2, sessionId: "tip-1", profile: "coder" }]);
  assert.equal(hermes.liveTransport("tip-1"), 2);

  hermes.rotate("tip-1", "rotated-tip", true);
  await flush();
  assert.equal(hermes.liveTransport("rotated-tip"), 2);

  b.rpc(11, "session.resume", { session_id: "ancestor-1", profile: "coder" });
  await flush();
  b.rpc(12, "session.resume", { session_id: "rotated-tip", profile: "coder" });
  await flush();
  b.rpc(13, "session.resume", { session_id: "rotated-tip", profile: "reviewer" });
  await flush();
  for (const id of [11, 12, 13]) assert.equal(b.errorCode(id), -32006);

  // Model a rotation event Office did not observe. The per-owner exclusion is
  // deliberately fail-closed across the read-only lookup/resume TOCTOU window.
  hermes.rotate("rotated-tip", "unobserved-tip", false);
  b.rpc(14, "session.resume", { session_id: "unobserved-tip", profile: "coder" });
  await flush();
  assert.equal(b.errorCode(14), -32006);

  assert.equal(hermes.resumeRequests.length, 1, "every losing claim must be rejected before upstream resume");
  assert.equal(hermes.rebindCount, 0, "the fake Hermes must never get a chance to rebind A's live transport");
  assert.equal(hermes.liveTransport("unobserved-tip"), 2);
  b.close(1000, "losing socket closed");
  await flush();
  assert.equal(hermes.liveTransport("unobserved-tip"), 2);
  assert.deepEqual(hermes.reapedTransportIds, [], "closing B must not reap A's globally registered live session");
  assert.deepEqual(hermes.resolveCalls.map(({ sessionId, profile }) => ({ sessionId, profile })), [
    { sessionId: "project-chat", profile: "coder" },
    { sessionId: "ancestor-1", profile: "coder" },
    { sessionId: "ancestor-1", profile: "coder" },
    { sessionId: "rotated-tip", profile: "coder" },
    { sessionId: "rotated-tip", profile: "reviewer" },
    { sessionId: "unobserved-tip", profile: "coder" },
  ]);
});

type LiveSession = {
  liveSessionId: string;
  storedSessionId: string;
  transportId: number;
  closeOnDisconnect: boolean;
};

class SideEffectfulFakeHermes {
  readonly resumeRequests: Array<{ transportId: number; sessionId: string; profile: string }> = [];
  readonly resolveCalls: Array<{ sessionId: string; profile: string }> = [];
  readonly reapedTransportIds: number[] = [];
  rebindCount = 0;
  #nextTransportId = 0;
  #nextLiveId = 0;
  readonly #callbacks = new Map<number, (event: HermesChatEvent) => void>();
  readonly #liveByStored = new Map<string, LiveSession>();
  readonly #identities = new Map<string, HermesCanonicalSession>([
    ["ancestor-1", { requestedSessionId: "ancestor-1", sessionId: "tip-1", path: ["ancestor-1", "tip-1"] }],
    ["tip-1", { requestedSessionId: "tip-1", sessionId: "tip-1", path: ["tip-1"] }],
  ]);

  runtime(): HermesRuntimeSource {
    return {
      chat: () => {
        let transportId: number | undefined;
        return {
          resolveSessionTip: async ({ sessionId, profile }: { sessionId: string; profile: string }) => {
            this.resolveCalls.push({ sessionId, profile });
            if (sessionId === "project-chat") throw new Error("title aliases are not canonical IDs");
            const identity = this.#identities.get(sessionId);
            if (identity === undefined) throw new Error("session not found");
            return { ...identity, path: [...identity.path] };
          },
          connect: async (onEvent: (event: HermesChatEvent) => void) => {
            transportId = ++this.#nextTransportId;
            const currentId = transportId;
            this.#callbacks.set(currentId, onEvent);
            return {
              closed: false,
              request: async (request: HermesChatRequest) => this.#request(currentId, request),
              close: async () => this.#close(currentId),
            };
          },
          fetchHistory: async () => { throw new Error("unused"); },
          inspectHistory: async () => { throw new Error("unused"); },
        };
      },
    } as unknown as HermesRuntimeSource;
  }

  liveTransport(storedSessionId: string): number | undefined {
    return this.#liveByStored.get(storedSessionId)?.transportId;
  }

  rotate(previous: string, next: string, publish: boolean): void {
    const live = this.#liveByStored.get(previous);
    assert.ok(live, `missing live session ${previous}`);
    this.#liveByStored.delete(previous);
    live.storedSessionId = next;
    this.#liveByStored.set(next, live);
    for (const [requested, identity] of this.#identities) {
      if (identity.sessionId !== previous) continue;
      this.#identities.set(requested, { requestedSessionId: requested, sessionId: next, path: [...identity.path, next] });
    }
    this.#identities.set(next, { requestedSessionId: next, sessionId: next, path: [next] });
    if (publish) this.#callbacks.get(live.transportId)?.({
      type: "session.info", sessionId: live.liveSessionId, payload: { storedSessionId: next },
    });
  }

  async #request(transportId: number, request: HermesChatRequest) {
    if (request.method !== "session.resume") return { method: request.method, value: { status: "ok" } };
    const sessionId = String(request.params?.session_id);
    const profile = String(request.params?.profile ?? "default");
    this.resumeRequests.push({ transportId, sessionId, profile });
    let live = this.#liveByStored.get(sessionId);
    if (live === undefined) {
      live = {
        liveSessionId: `live-${++this.#nextLiveId}`,
        storedSessionId: sessionId,
        transportId,
        closeOnDisconnect: request.params?.close_on_disconnect === true,
      };
      this.#liveByStored.set(sessionId, live);
    } else {
      // This is the dangerous Hermes behavior under test: lookup and transport
      // rebinding happen before session.resume returns to Office.
      live.transportId = transportId;
      live.closeOnDisconnect = request.params?.close_on_disconnect === true;
      this.rebindCount += 1;
    }
    return {
      method: request.method,
      value: { liveSessionId: live.liveSessionId, storedSessionId: live.storedSessionId, running: false, status: "idle" },
    };
  }

  async #close(transportId: number): Promise<void> {
    this.#callbacks.delete(transportId);
    for (const [key, live] of [...this.#liveByStored]) {
      if (live.transportId !== transportId || !live.closeOnDisconnect) continue;
      this.#liveByStored.delete(key);
      this.reapedTransportIds.push(transportId);
    }
  }
}

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  send(body: string, callback?: (error?: Error) => void): void { this.sent.push(body); callback?.(); }
  close(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, reason);
  }
  rpc(id: number, method: string, params: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })), false);
  }
  errorCode(id: number): number | undefined {
    return (this.frames().find((frame) => frame.id === id)?.error as { code?: number } | undefined)?.code;
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((body) => JSON.parse(body) as Record<string, unknown>);
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
