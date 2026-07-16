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
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const subscriber = { onEvent: () => undefined, onUnavailable: () => undefined };
  const normalAttach = hub.attach(normalOwner, subscriber);
  const liveAttach = hub.attach(liveOwner, subscriber);
  const normalRejected = assert.rejects(hub.request(normalOwner, { method: "session.create", params: { profile: "coder" } }));
  const ownedRejected = assert.rejects(hub.requestOwnedSession(
    liveOwner, "live-owned", { method: "prompt.submit", params: { session_id: "live-owned", text: "late" } },
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
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });

  const invalidRequests: HermesChatRequest[] = [
    { method: "session.create", params: { profile: "coder" } },
    { method: "session.resume", params: { session_id: "stored-owned", profile: "coder" } },
    { method: "session.close", params: { session_id: "live-owned" } },
    { method: "prompt.submit", params: { session_id: "live-other", text: "wrong target" } },
    { method: "approval.respond", params: { session_id: "live-other", approval_id: "approval", choice: "once" } },
  ];
  for (const request of invalidRequests) await assert.rejects(hub.requestOwnedSession(owner, "live-owned", request));
  assert.equal(upstreamRequests, 0);
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
