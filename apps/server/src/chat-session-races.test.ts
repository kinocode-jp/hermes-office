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
  principal: { id: "race-test", tier: "operator", local: false, deviceName: "Race test" },
  csrfToken: "c".repeat(32), expiresAt: "2099-01-01T00:00:00.000Z",
};

test("a durable pending resume cannot be closed before its live identity binds", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();

  client.rpc(1, "session.resume", { session_id: "pending-only", profile: "coder" });
  await settle();
  client.rpc(2, "session.close", { session_id: "pending-only" });
  await settle();
  assert.equal(client.errorCode(2), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, [], "closing an empty pending lease must not fabricate upstream work");

  hermes.resolvePendingOnly();
  await settle(4);
  assert.equal(client.errorCode(1), undefined);
  assert.ok(coordinator.ownerForLive("live-pending"));
  assert.equal(hermes.isLive("live-pending"), true);
});

test("a guessed live close cannot race ahead of its pending resume on the same socket", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();

  client.rpc(3, "session.resume", { session_id: "pending-only", profile: "coder" });
  await settle();
  client.rpc(4, "session.close", { session_id: "live-pending" });
  await settle();
  assert.equal(client.errorCode(4), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, []);

  hermes.resolvePendingOnly();
  await settle(4);
  assert.equal(client.errorCode(3), undefined);
  assert.ok(coordinator.ownerForLive("live-pending"));
  assert.equal(hermes.isLive("live-pending"), true);
});

test("another socket cannot close a guessed live id while resume is pending", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const owner = new FakeWebSocket();
  const other = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(other as unknown as WebSocket, dependencies);
  await settle();

  owner.rpc(5, "session.resume", { session_id: "pending-only", profile: "coder" });
  await settle();
  other.rpc(6, "session.close", { session_id: "live-pending" });
  await settle();
  assert.equal(other.errorCode(6), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, []);

  hermes.resolvePendingOnly();
  await settle(4);
  assert.equal(owner.errorCode(5), undefined);
  assert.ok(coordinator.ownerForLive("live-pending"));
  assert.equal(hermes.isLive("live-pending"), true);
});

test("unknown live and durable ids never reach explicit upstream close", async () => {
  const { hermes, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();

  client.rpc(7, "session.close", { session_id: "unknown-live" });
  client.rpc(8, "session.close", { session_id: "unknown-durable" });
  await settle(4);
  assert.equal(client.errorCode(7), -32000);
  assert.equal(client.errorCode(8), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, []);
});

test("an owned durable alias is not accepted by the live-only explicit close contract", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(9, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  client.rpc(10, "session.close", { session_id: "parent" });
  await settle(4);

  assert.equal(client.errorCode(10), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, []);
  assert.equal(hermes.isLive("live-old"), true);
  assert.ok(coordinator.ownerForLive("live-old"));
});

test("one socket independently routes equal durable ids from two profiles", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(50, "session.resume", { session_id: "shared", profile: "alpha" });
  client.rpc(51, "session.resume", { session_id: "shared", profile: "beta" });
  await settle(4);

  assert.equal(client.errorCode(50), undefined);
  assert.equal(client.errorCode(51), undefined);
  assert.equal(coordinator.ownerForLive("live-alpha"), coordinator.ownerForLive("live-beta"));
  assert.ok(coordinator.ownerForLive("live-alpha"));

  hermes.emit("live-alpha", "alpha-event");
  hermes.emit("live-beta", "beta-event");
  await settle();
  assert.equal(client.events("live-alpha").at(-1)?.payload?.text, "alpha-event");
  assert.equal(client.events("live-beta").at(-1)?.payload?.text, "beta-event");

  client.rpc(52, "prompt.submit", { session_id: "live-alpha", text: "alpha-prompt" });
  client.rpc(53, "session.interrupt", { session_id: "live-beta" });
  await settle(4);
  assert.deepEqual(hermes.targetedRequests, [
    { method: "prompt.submit", sessionId: "live-alpha" },
    { method: "session.interrupt", sessionId: "live-beta" },
  ]);

  client.rpc(54, "session.close", { session_id: "live-alpha" });
  await settle(4);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-alpha"]);
  assert.equal(coordinator.ownerForLive("live-alpha"), undefined);
  assert.ok(coordinator.ownerForLive("live-beta"));
  assert.equal(hermes.isLive("live-beta"), true);

  const betaEvents = client.events("live-beta").length;
  hermes.emit("live-alpha", "closed-alpha-event");
  hermes.emit("live-beta", "beta-continues");
  await settle();
  assert.equal(client.events("live-alpha").some((event) => event.payload?.text === "closed-alpha-event"), false);
  assert.equal(client.events("live-beta").length, betaEvents + 1);
  assert.equal(client.events("live-beta").at(-1)?.payload?.text, "beta-continues");
  client.rpc(57, "prompt.submit", { session_id: "live-beta", text: "still-running" });
  await settle();
  assert.deepEqual(hermes.targetedRequests.at(-1), { method: "prompt.submit", sessionId: "live-beta" });
});

test("two sockets independently own equal durable ids from different profiles", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const alpha = new FakeWebSocket();
  const beta = new FakeWebSocket();
  handleOfficeChatConnection(alpha as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(beta as unknown as WebSocket, dependencies);
  await settle();
  alpha.rpc(55, "session.resume", { session_id: "shared", profile: "alpha" });
  beta.rpc(56, "session.resume", { session_id: "shared", profile: "beta" });
  await settle(4);

  assert.equal(alpha.errorCode(55), undefined);
  assert.equal(beta.errorCode(56), undefined);
  const alphaOwner = coordinator.ownerForLive("live-alpha");
  const betaOwner = coordinator.ownerForLive("live-beta");
  assert.ok(alphaOwner);
  assert.ok(betaOwner);
  assert.notEqual(alphaOwner, betaOwner);

  hermes.emit("live-alpha", "only-alpha");
  hermes.emit("live-beta", "only-beta");
  await settle();
  assert.equal(alpha.events("live-alpha").at(-1)?.payload?.text, "only-alpha");
  assert.equal(alpha.events("live-beta").length, 0);
  assert.equal(beta.events("live-beta").at(-1)?.payload?.text, "only-beta");
  assert.equal(beta.events("live-alpha").length, 0);
});

test("durable aliases stay profile-scoped when a live id collides globally", () => {
  const coordinator = new ChatSessionCoordinator();
  const alphaOwner = {};
  const betaOwner = {};
  const alpha = coordinator.claimResume(alphaOwner, "alpha", "shared");
  const beta = coordinator.claimResume(betaOwner, "beta", "shared");
  assert.ok(alpha);
  assert.ok(beta);
  assert.equal(coordinator.bind(alpha, { storedSessionId: "alpha-tip", liveSessionId: "live-shared" }, false), "bound");
  assert.equal(coordinator.bind(beta, { storedSessionId: "beta-tip", liveSessionId: "live-shared" }, false), "conflict");
  assert.equal(coordinator.ownerForLive("live-shared"), alphaOwner);

  const alphaMustNotLearnBetaAlias = coordinator.claimResume({}, "alpha", "beta-tip");
  assert.ok(alphaMustNotLearnBetaAlias);
  coordinator.releaseFailedClaim(alphaMustNotLearnBetaAlias);
  const betaRetry = coordinator.claimResume(betaOwner, "beta", "shared");
  assert.ok(betaRetry);
  coordinator.releaseFailedClaim(betaRetry);
});

test("an owned close reservation blocks rebind after a lease release TOCTOU", () => {
  const coordinator = new ChatSessionCoordinator();
  const oldOwner = {};
  const first = coordinator.claimCreate(oldOwner, "coder");
  assert.equal(coordinator.bind(first, { storedSessionId: "stored", liveSessionId: "live" }, true), "bound");
  const snapshot = coordinator.leaseForSession(oldOwner, "live");
  assert.ok(snapshot);
  const closeToken = coordinator.claimOwnedLeaseClose(oldOwner, snapshot);
  assert.ok(closeToken);
  assert.equal(coordinator.releaseLease(oldOwner, snapshot.token), true);

  const racingOwner = {};
  const racing = coordinator.claimResume(racingOwner, "coder", "stored");
  assert.ok(racing);
  assert.equal(coordinator.bind(racing, { storedSessionId: "stored", liveSessionId: "live" }, false), "conflict");
  assert.equal(coordinator.ownerForLive("live"), undefined);

  coordinator.finishOwnedLeaseClose(snapshot, closeToken);
  const retry = coordinator.claimResume(racingOwner, "coder", "stored");
  assert.ok(retry);
  assert.equal(coordinator.bind(retry, { storedSessionId: "stored", liveSessionId: "live" }, false), "bound");
  assert.equal(coordinator.ownerForLive("live"), racingOwner);
});

test("a late duplicate result is closed after its old bound lease was explicitly closed", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(10, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  hermes.holdNextParentResume();
  client.rpc(11, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  client.rpc(12, "session.close", { session_id: "live-old" });
  await settle();
  assert.equal(client.errorCode(12), undefined);
  assert.equal(coordinator.ownerForLive("live-old"), undefined);

  hermes.resolveParentDuplicate();
  await settle(4);
  assert.equal(client.errorCode(11), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-old", "live-new"]);
  assert.deepEqual(hermes.liveIds(), []);
  assert.equal(client.events("live-new").length, 0);
});

test("an invalid create with a live id closes the unowned session", async () => {
  const { hermes, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(20, "session.create", { profile: "coder", title: "Invalid identity" });
  await settle();

  assert.equal(client.errorCode(20), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-invalid"]);
  assert.equal(hermes.isLive("live-invalid"), false);
  assert.equal(client.events("live-invalid").length, 0);
});

test("an authoritative already-absent close result does not reset existing owners", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const owner = new FakeWebSocket();
  const invalid = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(invalid as unknown as WebSocket, dependencies);
  await settle();
  owner.rpc(25, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  invalid.rpc(26, "session.create", { profile: "coder", title: "Invalid absent identity" });
  await settle(4);

  assert.equal(invalid.errorCode(26), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-invalid-absent"]);
  assert.ok(coordinator.ownerForLive("live-old"));
  assert.equal(owner.closed, undefined);
  assert.equal(hermes.connectionCloseCount, 0);
  assert.equal(invalid.events("live-invalid-absent").length, 0);
});

test("an invalid-result close failure resets the generation and reaps existing owners", async () => {
  const { hermes, dependencies } = setup();
  const owner = new FakeWebSocket();
  const invalid = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(invalid as unknown as WebSocket, dependencies);
  await settle();
  owner.rpc(30, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  hermes.failCloseFor.add("live-invalid");
  invalid.rpc(31, "session.create", { profile: "coder", title: "Invalid identity" });
  await settle(6);

  assert.deepEqual(hermes.sessionCloseRequests, ["live-invalid"]);
  assert.equal(owner.events("live-old").at(-1)?.payload?.status, "resync_required");
  assert.equal(owner.closed?.code, 1013);
  assert.equal(invalid.closed?.code, 1013);
  assert.equal(hermes.connectionCloseCount, 1);
  assert.deepEqual(hermes.liveIds(), []);
});

test("a create result without any live id resets the ambiguous shared generation", async () => {
  const { hermes, dependencies } = setup();
  const owner = new FakeWebSocket();
  const ambiguous = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(ambiguous as unknown as WebSocket, dependencies);
  await settle();
  owner.rpc(40, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  ambiguous.rpc(41, "session.create", { profile: "coder", title: "Missing live identity" });
  await settle(6);

  assert.deepEqual(hermes.sessionCloseRequests, [], "an unknown live id cannot be guessed for explicit close");
  assert.equal(owner.events("live-old").at(-1)?.payload?.status, "resync_required");
  assert.equal(owner.closed?.code, 1013);
  assert.equal(ambiguous.closed?.code, 1013);
  assert.equal(hermes.connectionCloseCount, 1);
  assert.deepEqual(hermes.liveIds(), []);
});

test("a resume result without any live id also resets the ambiguous shared generation", async () => {
  const { hermes, dependencies } = setup();
  const owner = new FakeWebSocket();
  const ambiguous = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(ambiguous as unknown as WebSocket, dependencies);
  await settle();
  owner.rpc(45, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  ambiguous.rpc(46, "session.resume", { session_id: "missing-live", profile: "coder" });
  await settle(6);

  assert.deepEqual(hermes.sessionCloseRequests, [], "an unknown live id cannot be guessed for explicit close");
  assert.equal(owner.events("live-old").at(-1)?.payload?.status, "resync_required");
  assert.equal(owner.closed?.code, 1013);
  assert.equal(ambiguous.closed?.code, 1013);
  assert.equal(hermes.connectionCloseCount, 1);
  assert.deepEqual(hermes.liveIds(), []);
});

function setup(): {
  hermes: RaceFakeHermes;
  coordinator: ChatSessionCoordinator;
  dependencies: Parameters<typeof handleOfficeChatConnection>[1];
} {
  const hermes = new RaceFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  return {
    hermes,
    coordinator,
    dependencies: {
      auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
      maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
      sessionCoordinator: coordinator, chatHub: new ChatUpstreamHub(runtime, coordinator, 64 * 1024),
    },
  };
}

class RaceFakeHermes {
  readonly sessionCloseRequests: string[] = [];
  readonly targetedRequests: Array<{ method: string; sessionId: string }> = [];
  readonly failCloseFor = new Set<string>();
  connectionCloseCount = 0;
  readonly #live = new Set<string>();
  #event: ((event: HermesChatEvent) => void) | undefined;
  #closed = false;
  #pendingOnly: ((result: HermesChatResult) => void) | undefined;
  #pendingParent: ((result: HermesChatResult) => void) | undefined;
  #holdParent = false;

  runtime(): HermesRuntimeSource {
    return {
      chat: () => ({
        connect: async (onEvent: (event: HermesChatEvent) => void) => {
          this.#event = onEvent;
          this.#closed = false;
          return {
            get closed() { return false; },
            request: async (request: HermesChatRequest) => await this.#request(request),
            close: async () => {
              this.connectionCloseCount += 1;
              this.#closed = true;
              this.#live.clear();
            },
          };
        },
        inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
        fetchHistory: async () => { throw new Error("unused"); },
      }),
    } as unknown as HermesRuntimeSource;
  }

  isLive(liveId: string): boolean { return this.#live.has(liveId); }
  liveIds(): string[] { return [...this.#live]; }
  emit(liveId: string, text: string): void {
    this.#event?.({ type: "message.delta", sessionId: liveId, payload: { text } });
  }
  holdNextParentResume(): void { this.#holdParent = true; }
  resolvePendingOnly(): void {
    this.#live.add("live-pending");
    this.#pendingOnly?.({ method: "session.resume", value: sessionValue("live-pending", "pending-only") });
    this.#pendingOnly = undefined;
  }
  resolveParentDuplicate(): void {
    this.#live.add("live-new");
    this.#pendingParent?.({ method: "session.resume", value: sessionValue("live-new", "parent") });
    this.#pendingParent = undefined;
  }

  async #request(request: HermesChatRequest): Promise<HermesChatResult> {
    if (this.#closed) throw new Error("generation closed");
    if (request.method === "prompt.submit" || request.method === "session.interrupt") {
      this.targetedRequests.push({ method: request.method, sessionId: String(request.params?.session_id) });
      return { method: request.method, value: { status: "ok" } };
    }
    if (request.method === "session.close") {
      const liveId = String(request.params?.session_id);
      this.sessionCloseRequests.push(liveId);
      if (this.failCloseFor.has(liveId)) throw new HermesChatTransportError("timed_out", "fake close timeout");
      return { method: request.method, value: { closed: this.#live.delete(liveId) } };
    }
    if (request.method === "session.create") {
      if (request.params?.title === "Invalid identity") {
        this.#live.add("live-invalid");
        this.#event?.({ type: "message.delta", sessionId: "live-invalid", payload: { text: "must be discarded" } });
        return { method: request.method, value: { liveSessionId: "live-invalid", running: false } };
      }
      if (request.params?.title === "Invalid absent identity") {
        this.#event?.({ type: "message.delta", sessionId: "live-invalid-absent", payload: { text: "must be discarded" } });
        return { method: request.method, value: { liveSessionId: "live-invalid-absent", running: false } };
      }
      if (request.params?.title === "Missing live identity") {
        this.#live.add("live-ambiguous");
        return { method: request.method, value: { storedSessionId: "stored-ambiguous", running: false } };
      }
    }
    if (request.method === "session.resume") {
      const storedId = String(request.params?.session_id);
      if (storedId === "shared") {
        const profile = String(request.params?.profile);
        const liveId = `live-${profile}`;
        this.#live.add(liveId);
        return { method: request.method, value: sessionValue(liveId, storedId) };
      }
      if (storedId === "pending-only") {
        return await new Promise<HermesChatResult>((resolve) => { this.#pendingOnly = resolve; });
      }
      if (storedId === "parent" && this.#holdParent) {
        this.#holdParent = false;
        return await new Promise<HermesChatResult>((resolve) => { this.#pendingParent = resolve; });
      }
      if (storedId === "missing-live") {
        this.#live.add("live-ambiguous-resume");
        return { method: request.method, value: { storedSessionId: storedId, running: false } };
      }
      this.#live.add("live-old");
      return { method: request.method, value: sessionValue("live-old", storedId) };
    }
    return { method: request.method, value: { status: "ok" } };
  }
}

function sessionValue(liveSessionId: string, storedSessionId: string): Record<string, boolean | string> {
  return { liveSessionId, storedSessionId, running: false, status: "idle" };
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
  errorCode(id: number): number | undefined {
    return (this.frames().find((frame) => frame.id === id)?.error as { code?: number } | undefined)?.code;
  }
  events(liveId: string): Array<{ type: string | undefined; payload: Record<string, unknown> | undefined }> {
    return this.frames().flatMap((frame) => {
      const params = frame.params as { sessionId?: string; type?: string; payload?: Record<string, unknown> } | undefined;
      return frame.method === "event" && params?.sessionId === liveId ? [{ type: params.type, payload: params.payload }] : [];
    });
  }
  frames(): Array<Record<string, unknown>> { return this.sent.map((body) => JSON.parse(body) as Record<string, unknown>); }
}

async function settle(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
