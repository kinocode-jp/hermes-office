import assert from "node:assert/strict";
import test from "node:test";
import { connectChatApi, type ChatApiCallbacks } from "../src/chat-api.ts";
import { OfficeDeviceAuthRequiredError, OfficeSessionUnavailableError } from "../src/office-api.ts";
import { openSessionIds, reconnectChatSession, registerChatRuntime, sessions, setChatSessionError } from "../src/store.ts";

test("chat renews an expired open lease once and reconnects with the replacement revision", async () => {
  const sockets: FakeWebSocket[] = [];
  const recoveries: number[] = [];
  const states: string[] = [];
  let revision = 7;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: revision };
    },
    recoverAuthentication: async (_serverUrl, rejectedRevision) => {
      recoveries.push(rejectedRevision);
      revision = 8;
    },
    reconnectDelay: () => 0,
  });

  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();

  assert.deepEqual(recoveries, [7]);
  assert.equal(states.filter((state) => state === "ready").length, 2);
  api.stop();
});

test("an upgrade 401 represented by pre-open error/1000 performs bounded authentication recovery", async () => {
  const sockets: FakeWebSocket[] = [];
  let recoveries = 0;
  let revision = 11;
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: revision };
    },
    recoverAuthentication: async (_serverUrl, rejectedRevision) => {
      assert.equal(rejectedRevision, 11);
      recoveries += 1;
      revision = 12;
    },
    reconnectDelay: () => 0,
  });

  await waitFor(() => sockets.length === 1);
  sockets[0]!.failBeforeOpen();
  sockets[0]!.failBeforeOpen();
  await waitFor(() => sockets.length === 2);
  assert.equal(recoveries, 1);
  api.stop();
});

test("revoked recovery enters authentication-required error without a reconnect loop", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  let recoveries = 0;
  let revision = 17;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: revision };
    },
    recoverAuthentication: async () => { recoveries += 1; throw new OfficeDeviceAuthRequiredError(); },
    reconnectDelay: () => 0,
  });

  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Device revoked");
  await waitFor(() => states.at(-1) === "error");
  await flush();
  assert.equal(recoveries, 1);
  assert.equal(sockets.length, 1);

  // A successful explicit login calls the registered Office retry, which also
  // invokes chat.retry(); that is the only path which resumes this transport.
  revision = 18;
  api.retry();
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();
  assert.equal(states.at(-1), "ready");
  api.stop();
});

test("temporary recovery honors Retry-After and reconnects without requesting device login", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  const minimumDelays: number[] = [];
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: sockets.length };
    },
    recoverAuthentication: async () => { throw new OfficeSessionUnavailableError("rate limited", 60_000); },
    reconnectDelay: (_attempt, minimumDelayMs) => { minimumDelays.push(minimumDelayMs); return 0; },
  });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();
  assert.deepEqual(minimumDelays, [60_000]);
  assert.equal(states.includes("ready"), true);
  api.stop();
});

test("trusted proxy configuration failure waits for manual retry instead of looping", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  const delays: number[] = [];
  let proxyHealthy = false;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: sockets.length };
    },
    recoverAuthentication: async () => {
      if (!proxyHealthy) throw new OfficeSessionUnavailableError("trusted proxy configuration required", 0, false);
    },
    reconnectDelay: (attempt) => { delays.push(attempt); return 0; },
  });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await waitFor(() => states.at(-1) === "error");
  await flush();
  assert.equal(sockets.length, 1);
  assert.deepEqual(delays, []);

  proxyHealthy = true;
  api.retry();
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();
  assert.equal(states.at(-1), "ready");
  api.stop();
});

test("a synchronized Office recovery rearms a chat-only halt exactly once for active targets", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  let synchronized!: (serverUrl: string, authRevision: number) => void;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: sockets.length };
    },
    recoverAuthentication: async () => { throw new OfficeSessionUnavailableError("proxy configuration", 0, false); },
    reconnectDelay: () => 0,
    subscribeSessionSynchronizations(observer) { synchronized = observer; return () => {}; },
  });
  api.ensureSession({ clientSessionId: "active", profileId: "profile" });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await waitFor(() => states.at(-1) === "error");

  synchronized("https://other.example", 2);
  assert.equal(sockets.length, 1);
  synchronized("https://office.example", 1);
  assert.equal(sockets.length, 1);
  synchronized("https://office.example", 2);
  synchronized("https://office.example", 2);
  await waitFor(() => sockets.length === 2);
  await flush();
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  assert.equal(states.at(-1), "ready");
  api.stop();
  synchronized("https://office.example", 3);
  await flush();
  assert.equal(sockets.length, 2);
});

test("stop aborts a barrier-blocked retry and a deleted target cannot resume", async () => {
  const sockets: FakeWebSocket[] = [];
  let opens = 0;
  let retryAborted = false;
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async (_url, _serverUrl, signal) => {
      opens += 1;
      if (opens === 1) {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return { socket: socket as unknown as WebSocket, authRevision: 1 };
      }
      return await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        retryAborted = true;
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true }));
    },
    recoverAuthentication: async () => { throw new OfficeSessionUnavailableError("proxy configuration", 0, false); },
    reconnectDelay: () => 0,
  });
  api.ensureSession({ clientSessionId: "deleted", profileId: "profile" });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await flush();
  api.retry();
  await waitFor(() => opens === 2);
  api.releaseSession("deleted");
  api.stop();
  await waitFor(() => retryAborted);
  assert.equal(sockets.length, 1);
});

test("manual Office retry supersedes a pending chat recovery without opening a duplicate socket", async () => {
  const sockets: FakeWebSocket[] = [];
  let finishRecovery!: () => void;
  const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: sockets.length };
    },
    recoverAuthentication: async () => await recovery,
    reconnectDelay: () => 0,
  });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await flush();
  api.retry();
  await waitFor(() => sockets.length === 2);
  finishRecovery();
  await flush();
  await flush();
  assert.equal(sockets.length, 2);
  api.stop();
});

test("ordinary open network loss reconnects without rotating authentication", async () => {
  const sockets: FakeWebSocket[] = [];
  let recoveries = 0;
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: 23 };
    },
    recoverAuthentication: async () => { recoveries += 1; },
    reconnectDelay: () => 0,
  });

  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1006, "network lost");
  await waitFor(() => sockets.length === 2);
  assert.equal(recoveries, 0);
  api.stop();
});

test("persistent pre-open failures spend one auth check and then stop after a bounded retry count", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  let recoveries = 0;
  let revision = 31;
  const api = connectChatApi({ ...callbacks(states), onSessionError: setChatSessionError }, {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: revision };
    },
    recoverAuthentication: async () => { recoveries += 1; revision += 1; },
    reconnectDelay: () => 0,
  });
  sessions.value = [{ id: "retry-client", profileId: "profile", title: "Retry", status: "ready", messages: [], connectionState: "connecting", historyState: "unloaded", remoteKind: "draft" }];
  openSessionIds.value = ["retry-client"];
  registerChatRuntime(api);

  for (let expected = 1; expected <= 3; expected += 1) {
    await waitFor(() => sockets.length === expected);
    sockets[expected - 1]!.failBeforeOpen();
  }
  await waitFor(() => states.at(-1) === "error");
  await flush();
  assert.equal(recoveries, 1);
  assert.equal(sockets.length, 3);
  assert.equal(sessions.value[0]?.connectionState, "error");
  reconnectChatSession("retry-client");
  await waitFor(() => sockets.length === 4);
  sockets[3]!.open();
  assert.equal(states.at(-1), "ready");
  api.stop();
  sessions.value = [];
  openSessionIds.value = [];
});

test("reconnect scheduling is single-timer and increases attempts after repeated open failures", async () => {
  const attempts: number[] = [];
  let opens = 0;
  const socket = new FakeWebSocket();
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      opens += 1;
      if (opens <= 2) throw new Error("network unavailable");
      return { socket: socket as unknown as WebSocket, authRevision: 29 };
    },
    reconnectDelay: (attempt) => { attempts.push(attempt); return 0; },
  });

  await waitFor(() => opens === 3);
  assert.deepEqual(attempts, [0, 1]);
  socket.open();
  api.stop();
});

test("repeated network bootstrap failures stop after the bounded reconnect budget", async () => {
  const states: string[] = [];
  let opens = 0;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => { opens += 1; throw new OfficeSessionUnavailableError("offline"); },
    reconnectDelay: () => 0,
  });
  await waitFor(() => opens === 6);
  assert.equal(opens, 6);
  assert.equal(states.at(-1), "error");
  api.stop();
});

function callbacks(states: string[]): ChatApiCallbacks {
  return {
    onSocketState(state) { states.push(state); },
    onHistoryLoading() {}, onHistory() {}, onHistoryError() {},
    onSessionConnecting() {}, onSessionReady() {}, onSessionDisconnected() {}, onSessionError() {}, onEvent() {},
  };
}

class FakeWebSocket {
  readyState = WebSocket.CONNECTING;
  readonly #listeners = new Map<string, Set<(event: CloseEvent | Event | MessageEvent) => void>>();
  #closed = false;

  addEventListener(type: string, listener: (event: CloseEvent | Event | MessageEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(): void {}
  open(): void {
    if (this.#closed) return;
    this.readyState = WebSocket.OPEN;
    this.#emit("open", new Event("open"));
  }
  close(code = 1000, reason = ""): void {
    this.serverClose(code, reason);
  }
  serverClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", { code, reason } as CloseEvent);
  }
  failBeforeOpen(): void {
    if (this.#closed) return;
    this.#emit("error", new Event("error"));
  }
  #emit(type: string, event: CloseEvent | Event | MessageEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Timed out waiting for chat authentication state");
}
