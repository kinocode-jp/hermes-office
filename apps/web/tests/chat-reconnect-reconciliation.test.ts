import assert from "node:assert/strict";
import test from "node:test";
import { connectChatApi, type ChatApiCallbacks } from "../src/chat-api.ts";
import { reconcileChatSessionConnecting, reconcileChatSessionReady } from "../src/chat-session-reconciliation.ts";
import type { ChatSession } from "../src/domain.ts";
import { canSubmitChatPrompt, isChatRunActive } from "../src/session-runtime.ts";
import {
  applyChatGatewayEvent,
  reduceChatGatewayEvent,
  registerChatRuntime,
  sendMessage,
  sessions,
  setChatSessionConnecting,
  setChatSessionDisconnected,
  setChatSessionError,
  setChatSessionReady
} from "../src/store.ts";

const baseSession: ChatSession = {
  id: "client-1",
  storedSessionId: "stored-1",
  profileId: "coder",
  title: "Reconnect",
  status: "ready",
  messages: [],
  remoteKind: "stored",
  connectionState: "ready",
  historyState: "loaded"
};

test("a new live generation terminalizes old rows while authoritative running resumes the new generation", () => {
  const stale: ChatSession = {
    ...baseSession,
    status: "waiting",
    streamingMessageId: "old-agent",
    pendingInteraction: {
      id: "approval:old",
      kind: "approval",
      approvalId: "old",
      choices: ["once"],
      allowPermanent: false,
      submitting: false
    },
    messages: [{ id: "old-agent", from: "agent", body: "partial", at: "00:00", status: "streaming" }]
  };

  const connecting = reconcileChatSessionConnecting(stale);
  assert.equal(isChatRunActive(connecting), false);
  assert.equal(connecting.pendingInteraction, undefined);
  assert.equal(connecting.messages[0]?.status, "cancelled");

  const running = reconcileChatSessionReady(connecting, "live-new", "stored-1", { running: true, status: "idle" });
  assert.equal(running.status, "streaming");
  assert.equal(isChatRunActive(running), true);
  assert.equal(canSubmitChatPrompt(running), false);

  const cold = reconcileChatSessionReady(connecting, "live-new", "stored-1", { running: false, status: "running" });
  assert.equal(cold.status, "ready");
  assert.equal(isChatRunActive(cold), false);
  assert.equal(canSubmitChatPrompt(cold), true);

  const infoRunning = reduceChatGatewayEvent(baseSession, {
    type: "session.info", liveSessionId: "live-new", payload: { running: true, status: "idle" }
  });
  assert.equal(infoRunning.status, "streaming");
  const delayedIdle = reduceChatGatewayEvent(infoRunning, {
    type: "session.info", liveSessionId: "live-new", payload: { running: false, status: "idle" }
  });
  assert.equal(delayedIdle, infoRunning);
});

test("prompt start, socket close, and cold resume unlock the composer without replaying the prompt", async () => {
  const sockets: FakeWebSocket[] = [];
  let rpcSequence = 0;
  const callbacks: ChatApiCallbacks = {
    onSocketState() {},
    onHistoryLoading() {},
    onHistory() {},
    onHistoryError() {},
    onSessionConnecting: setChatSessionConnecting,
    onSessionReady: setChatSessionReady,
    onSessionDisconnected: setChatSessionDisconnected,
    onSessionError: setChatSessionError,
    onEvent: applyChatGatewayEvent
  };
  const api = connectChatApi(callbacks, {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    fetchJson: async <T>() => ({
      sessionId: "stored-1",
      messages: [],
      pagination: { direction: "older", hasMore: false, returned: 0 }
    }) as T,
    reconnectDelay: () => 0,
    randomId: () => `rpc-${++rpcSequence}`
  });
  registerChatRuntime(api);
  sessions.value = [{ ...baseSession }];
  api.ensureSession({ clientSessionId: baseSession.id, profileId: baseSession.profileId, storedSessionId: baseSession.storedSessionId });

  await waitFor(() => sockets.length === 1);
  const oldSocket = sockets[0]!;
  await flush();
  oldSocket.open();
  await waitFor(() => oldSocket.frame("session.resume") !== undefined);
  const firstResume = oldSocket.frame("session.resume")!;
  oldSocket.respond(firstResume.id, { liveSessionId: "live-old", storedSessionId: "stored-1", running: false, status: "idle" });
  await flush();

  sendMessage(baseSession.id, "first prompt");
  const firstPrompt = oldSocket.frame("prompt.submit")!;
  oldSocket.event("live-old", "message.start", { messageId: "old-agent" });
  oldSocket.event("live-old", "approval.request", { approvalId: "old-approval", choices: ["once"], allowPermanent: false });
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(sessions.value[0]?.pendingInteraction?.id, "approval:old-approval");

  oldSocket.close(1006, "network lost");
  await waitFor(() => sockets.length === 2);
  assert.equal(isChatRunActive(sessions.value[0]!), false);
  assert.equal(sessions.value[0]?.pendingInteraction, undefined);
  assert.equal(sessions.value[0]?.messages.find(({ id }) => id === "old-agent")?.status, "cancelled");

  const newSocket = sockets[1]!;
  await flush();
  newSocket.open();
  await waitFor(() => newSocket.frame("session.resume") !== undefined);
  const coldResume = newSocket.frame("session.resume")!;
  newSocket.respond(coldResume.id, { liveSessionId: "live-new", storedSessionId: "stored-1", running: false, status: "idle" });
  await flush();
  assert.equal(sessions.value[0]?.connectionState, "ready");
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), true);

  sendMessage(baseSession.id, "second prompt");
  const secondPrompt = newSocket.frame("prompt.submit")!;
  newSocket.event("live-new", "message.start", { messageId: "new-agent" });
  assert.equal(isChatRunActive(sessions.value[0]!), true);

  oldSocket.respond(firstPrompt.id, { status: "accepted" });
  oldSocket.event("live-old", "message.complete", { messageId: "old-agent", text: "stale completion" });
  oldSocket.event("live-old", "session.info", { running: false, status: "idle" });
  assert.equal(sessions.value[0]?.streamingMessageId, "new-agent");
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
  assert.deepEqual([...oldSocket.frames("prompt.submit"), ...newSocket.frames("prompt.submit")].map(({ params }) => params.text), ["first prompt", "second prompt"]);

  newSocket.respond(secondPrompt.id, { status: "accepted" });
  newSocket.close(1006, "auth synchronized reconnect");
  await waitFor(() => sockets.length === 3);
  const runningSocket = sockets[2]!;
  await flush();
  runningSocket.open();
  await waitFor(() => runningSocket.frame("session.resume") !== undefined);
  const runningResume = runningSocket.frame("session.resume")!;
  runningSocket.respond(runningResume.id, { liveSessionId: "live-running", storedSessionId: "stored-1", running: true, status: "idle" });
  await flush();
  assert.equal(sessions.value[0]?.status, "streaming");
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
  newSocket.event("live-new", "message.complete", { messageId: "new-agent", text: "stale completion" });
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal([...oldSocket.frames("prompt.submit"), ...newSocket.frames("prompt.submit"), ...runningSocket.frames("prompt.submit")].length, 2);
  api.stop();
});

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
  respond(id: string, result: unknown): void {
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }
  event(liveSessionId: string, type: string, payload: Record<string, unknown>): void {
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { session_id: liveSessionId, type, payload } }) });
  }
  frame(method: string): RpcFrame | undefined { return this.frames(method)[0]; }
  frames(method: string): RpcFrame[] { return this.sent.filter((frame) => frame.method === method); }
  #emit(type: string, event: { data?: string; code?: number; reason?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for chat reconnect");
}
