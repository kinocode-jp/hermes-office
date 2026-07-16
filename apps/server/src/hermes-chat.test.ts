import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  createHermesChatTransport,
  HermesChatTransportError,
  type HermesChatEvent,
  type HermesChatRequest,
} from "./hermes-chat.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("fetchHistory authenticates internally and returns a bounded secret-safe DTO", async (t) => {
  const observedUrls: string[] = [];
  let observedToken = "";
  const server = createServer((request, response) => {
    const observedUrl = request.url ?? "";
    observedUrls.push(observedUrl);
    observedToken = String(request.headers["x-hermes-session-token"] ?? "");
    if (!observedUrl.includes("/messages?")) {
      writeJson(response, { id: "resolved-42", message_count: 501, system_prompt: "must never escape" });
      return;
    }
    const historyRows = [
      { role: "system", content: "internal system prompt", timestamp: 1_700_000_000 },
      { role: "user", content: "Use token=supersecretvalue in this turn", timestamp: 1_700_000_001 },
      { role: "assistant", content: [{ type: "text", text: "Working" }, { type: "image", data: "hidden" }] },
      { role: "tool", content: "PRIVATE OUTPUT", tool_name: "terminal" },
      { role: "invalid", content: "drop" },
    ];
    const requestedLimit = Number(new URL(observedUrl, "http://127.0.0.1").searchParams.get("limit") ?? historyRows.length);
    writeJson(response, {
      session_id: "resolved-42",
      messages: historyRows.slice(0, requestedLimit),
      system_prompt: "must never escape",
      model_config: { api_key: "must never escape" },
    });
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const transport = createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN });
  const summary = await transport.inspectHistory({ sessionId: "session-42", profile: "coder" });
  const history = await transport.fetchHistory({
    sessionId: "session-42",
    profile: "coder",
    limit: 4,
    offset: 2,
  });

  assert.equal(observedToken, TOKEN);
  assert.deepEqual(summary, { sessionId: "resolved-42", total: 501 });
  assert.ok(observedUrls.some((url) => /^\/api\/sessions\/session-42\/messages\?/.test(url) && url.includes("limit=1") && url.includes("offset=0")));
  assert.ok(observedUrls.some((url) => /^\/api\/sessions\/resolved-42\?/.test(url) && url.includes("profile=coder")));
  assert.ok(observedUrls.some((url) => /^\/api\/sessions\/session-42\/messages\?/.test(url) && url.includes("limit=4") && url.includes("offset=2")));
  assert.deepEqual(history.pagination, { limit: 4, offset: 2, returned: 4, normalizedReturned: 4, dropped: 0 });
  assert.equal(history.sessionId, "resolved-42");
  assert.deepEqual(history.messages.map((message) => message.role), ["system", "user", "assistant", "tool"]);
  assert.equal(history.messages[0]?.text, "[System message hidden]");
  assert.equal(history.messages[1]?.text, "Use token=[REDACTED] in this turn");
  assert.equal(history.messages[2]?.text, "Working");
  assert.equal(history.messages[3]?.text, "[Tool output hidden]");
  assert.equal(history.messages[3]?.toolName, "terminal");
  assert.equal(JSON.stringify(history).includes("must never escape"), false);
  assert.equal(JSON.stringify(history).includes("PRIVATE OUTPUT"), false);
});

test("fetchHistory counts and safely drops individual malformed wire rows", async (t) => {
  const server = createServer((_request, response) => writeJson(response, {
    session_id: "resolved-safe",
    messages: [
      { role: "user", content: "kept" },
      { role: "future-role", content: "raw payload secret=never-return-this" },
      null,
      { role: "assistant", content: "also kept", timestamp: 1_700_000_001 },
      { role: "user", content: "bad timestamp secret=never-return-this", timestamp: "tomorrow" },
    ],
    api_key: "never-return-this",
  }));
  const origin = await listen(server);
  t.after(() => server.close());

  const history = await createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN }).fetchHistory({
    sessionId: "stored-safe",
    profile: "coder",
    limit: 5,
    offset: 0,
  });
  assert.deepEqual(history.messages.map(({ index, text }) => ({ index, text })), [
    { index: 0, text: "kept" },
    { index: 3, text: "also kept" },
  ]);
  assert.deepEqual(history.pagination, { limit: 5, offset: 0, returned: 5, normalizedReturned: 2, dropped: 3 });
  assert.equal(JSON.stringify(history).includes("never-return-this"), false);
  assert.equal(JSON.stringify(history).includes("raw payload"), false);
});

test("chat connection sends only validated allowlisted RPC and normalizes results/events", async (t) => {
  const events: HermesChatEvent[] = [];
  const received: Array<Record<string, unknown>> = [];
  let observedToken = "";
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    observedToken = url.searchParams.get("token") ?? "";
    sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request));
  });
  sockets.on("connection", (websocket) => {
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "secret.request", session_id: "live-1", payload: { request_id: "secret-1", prompt: "API key" } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "status.update", session_id: "live-1", payload: { kind: "process", text: "Preparing follow-up", private_state: "hidden" } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "approval.request", session_id: "live-1", payload: { command: "curl https://x/?token=supersecretvalue", description: "Network action", choices: ["once", "deny"], allow_permanent: false, raw_args: { password: "hidden" } } } }));
    websocket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      received.push(frame);
      const params = frame.params as Record<string, unknown>;
      websocket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { session_id: "live-1", stored_session_id: "stored-1", message_count: 0, running: false, status: "idle", cwd: "/private/path", token: "hidden", echoed: params } }));
    });
  });
  const origin = await listen(http);
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const transport = createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN });
  const connection = await transport.connect((event) => events.push(event));
  const result = await connection.request({ method: "session.create", params: { profile: "coder", title: "New chat" } });
  await connection.request(
    { method: "session.create", params: { profile: "coder", title: "Seeded chat" } },
    { sessionCreateSystemSeed: "Office shared context" },
  );
  await connection.request({ method: "session.resume", params: { session_id: "stored-1", profile: "coder" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(observedToken, TOKEN);
  assert.equal(received.length, 3);
  assert.equal(received[0]?.method, "session.create");
  assert.deepEqual(received[0]?.params, { profile: "coder", title: "New chat", close_on_disconnect: true, source: "desktop" });
  assert.deepEqual(received[1]?.params, { profile: "coder", title: "Seeded chat", close_on_disconnect: true, source: "desktop", messages: [{ role: "system", content: "Office shared context" }] });
  assert.deepEqual(received[2]?.params, { session_id: "stored-1", profile: "coder", close_on_disconnect: true, source: "desktop" });
  assert.deepEqual(result.value, { liveSessionId: "live-1", storedSessionId: "stored-1", messageCount: 0, running: false, status: "idle" });
  assert.equal(JSON.stringify(result).includes("private/path"), false);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { type: "status.update", sessionId: "live-1", payload: { kind: "process", message: "Preparing follow-up" } });
  assert.equal(events[1]?.type, "approval.request");
  assert.equal(events[1]?.payload.command, "curl https://x/?token=[REDACTED]");
  assert.equal(JSON.stringify(events).includes("hidden"), false);
  await connection.close();
});

test("chat boundary rejects arbitrary methods, unsafe params, IDs, and profiles before I/O", async (t) => {
  let frameCount = 0;
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => websocket.on("message", () => { frameCount += 1; }));
  const origin = await listen(http);
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const transport = createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN });
  const connection = await transport.connect(() => undefined);
  await assert.rejects(
    connection.request({ method: "secret.respond", params: { request_id: "a", value: "secret" } } as unknown as HermesChatRequest),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    connection.request({ method: "session.create", params: { profile: "../escape", cwd: "/tmp" } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    connection.request({ method: "session.create", params: { profile: "coder", messages: [{ role: "system", content: "browser seed" }] } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    transport.fetchHistory({ sessionId: "../../state.db", profile: "coder" }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  assert.equal(frameCount, 0);
  await connection.close();
});

test("chat boundary returns public errors without reflecting Hermes details", async (t) => {
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => websocket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    websocket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: 5000, message: "Failed at /Users/private with api_key=supersecretvalue", data: { token: "hidden" } } }));
  }));
  const origin = await listen(http);
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const connection = await createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN }).connect(() => undefined);
  await assert.rejects(
    connection.request({ method: "session.interrupt", params: { session_id: "live-1" } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.message === "Hermes rejected the chat request." && !error.message.includes("private"),
  );
  await connection.close();
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function writeJson(response: ServerResponse<IncomingMessage>, value: unknown): void {
  const text = JSON.stringify(value);
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}
