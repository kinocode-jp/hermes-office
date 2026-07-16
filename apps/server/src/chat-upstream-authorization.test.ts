import assert from "node:assert/strict";
import test from "node:test";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import type { HermesChatConnection, HermesChatRequest } from "./hermes-chat.js";
import { ChatSessionCoordinator } from "./chat-session-coordinator.js";
import { ChatUpstreamHub } from "./chat-upstream-hub.js";

test("a detach while connect is pending prevents normal and owned upstream requests", async () => {
  let resolveConnection!: (connection: HermesChatConnection) => void;
  const connectionReady = new Promise<HermesChatConnection>((resolve) => { resolveConnection = resolve; });
  let upstreamRequests = 0;
  const connection: HermesChatConnection = {
    closed: false,
    request: async (request) => {
      upstreamRequests += 1;
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => undefined,
  };
  const runtime = runtimeWithConnect(async () => await connectionReady);
  const coordinator = new ChatSessionCoordinator();
  const normalOwner = {};
  const liveOwner = {};
  const liveClaim = coordinator.claimCreate(liveOwner, "coder");
  assert.equal(coordinator.bind(liveClaim, { storedSessionId: "stored-owned", liveSessionId: "live-owned" }, true), "bound");
  const liveToken = coordinator.liveLeaseToken(liveOwner, "live-owned");
  assert.ok(liveToken);
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const subscriber = { onEvent: () => undefined, onUnavailable: () => undefined };
  const normalAttach = hub.attach(normalOwner, subscriber);
  const liveAttach = hub.attach(liveOwner, subscriber);
  const normalRejected = assert.rejects(hub.request(normalOwner, { method: "session.create", params: { profile: "coder" } }));
  const ownedRejected = assert.rejects(hub.requestOwnedSession(
    liveOwner, "live-owned", liveToken,
    { method: "prompt.submit", params: { session_id: "live-owned", text: "late" } },
  ));

  hub.detach(normalOwner);
  hub.detach(liveOwner);
  resolveConnection(connection);
  await Promise.all([normalAttach, liveAttach, normalRejected, ownedRejected]);
  assert.equal(upstreamRequests, 0);
  await hub.close();
});

test("the owned-session request path rejects methods and wire targets outside its capability", async () => {
  let upstreamRequests = 0;
  const runtime = runtimeWithConnect(async () => ({
    closed: false,
    request: async (request: HermesChatRequest) => {
      upstreamRequests += 1;
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => undefined,
  }));
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const claim = coordinator.claimCreate(owner, "coder");
  assert.equal(coordinator.bind(claim, { storedSessionId: "stored-owned", liveSessionId: "live-owned" }, true), "bound");
  const leaseToken = coordinator.liveLeaseToken(owner, "live-owned");
  assert.ok(leaseToken);
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });

  const invalidRequests: HermesChatRequest[] = [
    { method: "session.create", params: { profile: "coder" } },
    { method: "session.resume", params: { session_id: "stored-owned", profile: "coder" } },
    { method: "session.close", params: { session_id: "live-owned" } },
    { method: "prompt.submit", params: { session_id: "live-other", text: "wrong target" } },
    { method: "approval.respond", params: { session_id: "live-other", approval_id: "approval", choice: "once" } },
  ];
  for (const request of invalidRequests) {
    await assert.rejects(hub.requestOwnedSession(owner, "live-owned", leaseToken, request));
  }
  assert.equal(upstreamRequests, 0);
  await hub.close();
});

test("connect-wait commands cannot cross same-owner same-live lease reuse", async () => {
  let resolveConnection!: (connection: HermesChatConnection) => void;
  const connectionReady = new Promise<HermesChatConnection>((resolve) => { resolveConnection = resolve; });
  let upstreamRequests = 0;
  const connection: HermesChatConnection = {
    closed: false,
    request: async (request) => {
      upstreamRequests += 1;
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => undefined,
  };
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const oldClaim = coordinator.claimResume(owner, "coder", "stored");
  assert.ok(oldClaim);
  assert.equal(coordinator.bind(oldClaim, { storedSessionId: "stored", liveSessionId: "live-reused" }, false), "bound");
  const oldToken = coordinator.liveLeaseToken(owner, "live-reused");
  assert.ok(oldToken);
  const hub = new ChatUpstreamHub(runtimeWithConnect(async () => await connectionReady), coordinator, 64 * 1024);
  const attaching = hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });
  const methods = ["prompt.submit", "session.steer", "session.interrupt"] as const;
  const rejected = methods.map((method) => assert.rejects(hub.requestOwnedSession(
    owner, "live-reused", oldToken,
    method === "session.interrupt"
      ? { method, params: { session_id: "live-reused" } }
      : { method, params: { session_id: "live-reused", text: "stale" } },
  )));

  assert.equal(coordinator.releaseLease(owner, oldToken), true);
  const newClaim = coordinator.claimResume(owner, "coder", "stored");
  assert.ok(newClaim);
  assert.equal(coordinator.bind(newClaim, { storedSessionId: "stored", liveSessionId: "live-reused" }, false), "bound");
  assert.notEqual(coordinator.liveLeaseToken(owner, "live-reused"), oldToken);
  resolveConnection(connection);
  await Promise.all([attaching, ...rejected]);
  assert.equal(upstreamRequests, 0);
  await hub.close();
});

test("durable alias convergence preserves the live lease token", async () => {
  let upstreamRequests = 0;
  const runtime = runtimeWithConnect(async () => ({
    closed: false,
    request: async (request: HermesChatRequest) => {
      upstreamRequests += 1;
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => undefined,
  }));
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const first = coordinator.claimResume(owner, "coder", "stored-a");
  assert.ok(first);
  assert.equal(coordinator.bind(first, { storedSessionId: "stored-a", liveSessionId: "live" }, false), "bound");
  const token = coordinator.liveLeaseToken(owner, "live");
  assert.ok(token);
  const alias = coordinator.claimResume(owner, "coder", "stored-a");
  assert.ok(alias);
  assert.equal(coordinator.bind(alias, { storedSessionId: "stored-b", liveSessionId: "live" }, false), "bound");
  assert.equal(coordinator.liveLeaseToken(owner, "live"), token);

  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });
  await hub.requestOwnedSession(owner, "live", token, {
    method: "prompt.submit", params: { session_id: "live", text: "same lease" },
  });
  assert.equal(upstreamRequests, 1);
  await hub.close();
});

function runtimeWithConnect(connect: () => Promise<HermesChatConnection>): HermesRuntimeSource {
  return {
    chat: () => ({
      connect,
      inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
      fetchHistory: async () => { throw new Error("unused"); },
    }),
  } as unknown as HermesRuntimeSource;
}
