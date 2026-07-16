import assert from "node:assert/strict";
import test from "node:test";
import { connectChatApi, type ChatApiCallbacks } from "../src/chat-api.ts";

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

test("revoked or rate-limited recovery enters authentication-required error without a reconnect loop", async () => {
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
    recoverAuthentication: async () => { recoveries += 1; throw new Error("device revoked"); },
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
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: revision };
    },
    recoverAuthentication: async () => { recoveries += 1; revision += 1; },
    reconnectDelay: () => 0,
  });

  for (let expected = 1; expected <= 3; expected += 1) {
    await waitFor(() => sockets.length === expected);
    sockets[expected - 1]!.failBeforeOpen();
  }
  await waitFor(() => states.at(-1) === "error");
  await flush();
  assert.equal(recoveries, 1);
  assert.equal(sockets.length, 3);
  api.stop();
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Timed out waiting for chat authentication state");
}
