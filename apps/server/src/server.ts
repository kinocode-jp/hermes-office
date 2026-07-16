import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { EventEnvelope, EventTopic, ProtocolError } from "@hermes-office/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { OfficeAuth, type OfficeAuditRecord } from "./office-auth.js";
import { HERMES_CHAT_METHODS, type HermesChatMethod } from "./hermes-chat.js";
import { isKanbanHttpPath, isKanbanMutation, routeKanbanHttp } from "./kanban-http.js";
import { isSettingsHttpPath, isSettingsMutation, routeSettingsHttp } from "./settings-http.js";
import { DeviceAuthBodyError, readDeviceAuthBody } from "./device-auth-http.js";
import { StaticWebAssets, type StaticWebAsset } from "./static-web.js";
import {
  OFFICE_PROTOCOL_VERSION,
  createDemoRuntimeStatus,
  createDemoSnapshot,
} from "./demo-state.js";

const DEFAULT_ORIGINS = [
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
] as const;

export interface OfficeServerOptions {
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  allowNonLoopback?: boolean;
  maxJsonBytes?: number;
  maxEventBytes?: number;
  maxWebSocketClients?: number;
  runtimeSource?: HermesRuntimeSource;
  remoteToken?: string;
  desktopCapability?: string;
  desktopOrigins?: readonly string[];
  staticWebRoot?: string;
}

export interface OfficeServer {
  readonly host: string;
  readonly port: number;
  readonly originAllowlist: ReadonlySet<string>;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
  broadcast<T>(topic: EventTopic, payload: T, aggregateId?: string): boolean;
}

export function createOfficeServer(options: OfficeServerOptions = {}): OfficeServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const maxJsonBytes = boundedInteger(options.maxJsonBytes, 64 * 1024, 1_024, 1024 * 1024);
  const maxEventBytes = boundedInteger(options.maxEventBytes, 64 * 1024, 1_024, 1024 * 1024);
  const maxWebSocketClients = boundedInteger(options.maxWebSocketClients, 32, 1, 256);
  const originAllowlist = new Set(makeOriginAllowlist(
    options.allowedOrigins ?? defaultOriginsForPort(port),
  ));
  const runtimeSource = options.runtimeSource;
  const staticWeb = options.staticWebRoot === undefined ? undefined : new StaticWebAssets(options.staticWebRoot);
  let publishAudit = (_record: OfficeAuditRecord): void => {};
  const auth = new OfficeAuth({
    ...(options.remoteToken === undefined ? {} : { remoteToken: options.remoteToken }),
    ...(options.desktopCapability === undefined ? {} : { desktopCapability: options.desktopCapability }),
    ...(options.desktopOrigins === undefined ? {} : { desktopOrigins: options.desktopOrigins }),
    onAudit: (record) => publishAudit(record),
  });

  if (!isLoopbackHost(host)) {
    if (!options.allowNonLoopback) {
      throw new Error(`Refusing non-loopback bind (${host}) without allowNonLoopback.`);
    }
    if (!auth.remoteEnabled) {
      throw new Error(`Refusing non-loopback bind (${host}) without a remote access token.`);
    }
  }

  let sequence = 0;
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxJsonBytes,
    perMessageDeflate: false,
    clientTracking: true,
  });
  const chatWebSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxJsonBytes,
    perMessageDeflate: false,
    clientTracking: true,
  });
  const eventSocketPrincipals = new WeakMap<WebSocket, string>();
  const chatSocketPrincipals = new WeakMap<WebSocket, string>();
  publishAudit = (record) => {
    const publicRecord = {
      occurredAt: record.occurredAt,
      operation: record.operation,
      outcome: record.outcome,
      deviceName: record.deviceName,
      local: record.local,
    };
    const event = makeEvent(++sequence, "access.changed", { audit: publicRecord });
    for (const client of websocketServer.clients) sendBoundedEvent(client, event, maxEventBytes);
    if (record.operation === "auth.logout" && record.actorId !== null) {
      for (const client of websocketServer.clients) {
        if (eventSocketPrincipals.get(client) === record.actorId) client.close(1008, "Session revoked");
      }
      for (const client of chatWebSocketServer.clients) {
        if (chatSocketPrincipals.get(client) === record.actorId) client.close(1008, "Session revoked");
      }
    }
  };

  const httpServer = createHttpServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    applySecurityHeaders(response);

    const origin = request.headers.origin;
    if (origin !== undefined && !originAllowlist.has(normalizeOrigin(origin))) {
      writeError(response, 403, "forbidden", "Origin is not allowed.", maxJsonBytes);
      return;
    }

    if (origin !== undefined) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Vary", "Origin");
    }

    const requestUrl = parseRequestUrl(request.url);
    if (requestUrl === undefined) {
      writeError(response, 400, "bad_request", "Malformed request URL.", maxJsonBytes);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/auth/local") {
      if (origin === undefined || requestHasBody(request)) {
        writeError(response, 400, "bad_request", "Local bootstrap requires an allowed browser origin and no body.", maxJsonBytes);
        return;
      }
      const session = auth.bootstrapLocal(request, response);
      if (session === undefined) writeError(response, 403, "forbidden", "Local bootstrap is loopback-only.", maxJsonBytes);
      else writeJson(response, 200, session, maxJsonBytes);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/auth/device") {
      if (!auth.remoteEnabled) {
        request.resume();
        writeError(response, 404, "not_found", "Route not found.", maxJsonBytes);
        return;
      }
      try {
        const credentials = await readDeviceAuthBody(request, maxJsonBytes);
        const result = auth.bootstrapDevice(request, response, credentials);
        if (result.outcome === "success") writeJson(response, 200, result.session, maxJsonBytes);
        else if (result.outcome === "rate_limited") {
          writeError(response, 429, "rate_limited", "Too many device authentication attempts.", maxJsonBytes, { "Retry-After": "60" });
        } else {
          writeError(response, 401, "unauthenticated", "Device credentials are invalid.", maxJsonBytes);
        }
      } catch (error) {
        if (error instanceof DeviceAuthBodyError) {
          writeError(response, error.status, "bad_request", error.message, maxJsonBytes);
        } else {
          writeError(response, 400, "bad_request", "Device authentication request is invalid.", maxJsonBytes);
        }
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/auth/logout") {
      if (requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "Logout request bodies are not accepted.", maxJsonBytes);
      } else if (auth.authenticate(request) === undefined) {
        writeError(response, 401, "unauthenticated", "Office session is not active.", maxJsonBytes);
      } else if (auth.authorizeMutation(request) === undefined) {
        writeError(response, 403, "forbidden", "A valid Office session and CSRF token are required.", maxJsonBytes);
      } else if (!auth.revoke(request, response)) {
        writeError(response, 401, "unauthenticated", "Office session is not active.", maxJsonBytes);
      } else {
        writeJson(response, 200, { ok: true }, maxJsonBytes);
      }
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token, X-Hermes-Office-Desktop-Capability",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }

    if (isKanbanHttpPath(requestUrl.pathname)) {
      if (auth.authenticate(request) === undefined) {
        request.resume();
        writeError(response, 401, "unauthenticated", "Office session is required.", maxJsonBytes);
        return;
      }
      if (isKanbanMutation(request.method) && auth.authorizeMutation(request) === undefined) {
        request.resume();
        writeError(response, 403, "forbidden", "A valid CSRF token is required.", maxJsonBytes);
        return;
      }
      if (request.method === "GET" && requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "GET request bodies are not accepted.", maxJsonBytes);
        return;
      }
      if (runtimeSource === undefined) {
        request.resume();
        writeError(response, 503, "runtime_unavailable", "Hermes runtime is unavailable.", maxJsonBytes);
        return;
      }
      try {
        const result = await routeKanbanHttp(request, requestUrl, runtimeSource.kanban(), maxJsonBytes);
        if (!request.readableEnded) request.resume();
        writeJson(response, result.status, result.body, maxJsonBytes, result.headers ?? {});
        if (result.changedCardId !== undefined && result.status >= 200 && result.status < 300) {
          const event = makeEvent(++sequence, "kanban.changed", {
            cardId: result.changedCardId,
            operation: result.changedOperation ?? "card.updated",
          }, result.changedCardId);
          for (const client of websocketServer.clients) sendBoundedEvent(client, event, maxEventBytes);
        }
      } catch {
        writeError(response, 502, "runtime_unavailable", "Hermes Kanban is unavailable.", maxJsonBytes);
      }
      return;
    }

    if (isSettingsHttpPath(requestUrl.pathname)) {
      if (auth.authenticate(request) === undefined) {
        request.resume();
        writeError(response, 401, "unauthenticated", "Office session is required.", maxJsonBytes);
        return;
      }
      if (isSettingsMutation(request.method) && auth.authorizeMutation(request) === undefined) {
        request.resume();
        writeError(response, 403, "forbidden", "A valid CSRF token is required.", maxJsonBytes);
        return;
      }
      if (request.method === "GET" && requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "GET request bodies are not accepted.", maxJsonBytes);
        return;
      }
      if (runtimeSource?.settings === undefined || runtimeSource.globalSettings === undefined) {
        request.resume();
        writeError(response, 503, "runtime_unavailable", "Hermes settings are unavailable.", maxJsonBytes);
        return;
      }
      const result = await routeSettingsHttp(
        request,
        requestUrl,
        {
          settings: runtimeSource.settings(),
          globalSettings: runtimeSource.globalSettings(),
          ...(runtimeSource.globalInheritance === undefined ? {} : { globalInheritance: runtimeSource.globalInheritance() }),
        },
        maxJsonBytes,
      );
      if (!request.readableEnded) request.resume();
      writeJson(response, result.status, result.body, maxJsonBytes, result.headers ?? {});
      if (result.changed !== undefined && result.status >= 200 && result.status < 300) {
        const aggregateId = result.changed.profile ?? result.changed.id ?? "global";
        const event = makeEvent(++sequence, "profile.changed", result.changed, aggregateId);
        for (const client of websocketServer.clients) sendBoundedEvent(client, event, maxEventBytes);
      }
      return;
    }

    if (requestHasBody(request)) {
      request.resume();
      response.setHeader("Connection", "close");
      writeError(response, 413, "bad_request", "Request bodies are not accepted.", maxJsonBytes);
      return;
    }

    if (
      staticWeb !== undefined
      && (request.method === "GET" || request.method === "HEAD")
      && !isApiPath(requestUrl.pathname)
    ) {
      try {
        const asset = await staticWeb.read(requestUrl.pathname);
        if (asset === undefined) {
          writeError(response, 404, "not_found", "Web asset not found.", maxJsonBytes);
        } else {
          writeStaticWebAsset(response, request.method, asset);
        }
      } catch {
        writeError(response, 500, "internal_error", "Web application is unavailable.", maxJsonBytes);
      }
      return;
    }

    if (request.method !== "GET") {
      writeError(response, 405, "bad_request", "Method not allowed.", maxJsonBytes, {
        Allow: "GET, OPTIONS",
      });
      return;
    }

    if (requestUrl.pathname === "/api/v1/health") {
      const runtime = runtimeSource?.status() ?? createDemoRuntimeStatus();
      writeJson(
        response,
        200,
        {
          ok: true,
          protocolVersion: OFFICE_PROTOCOL_VERSION,
          runtime: runtime.state,
        },
        maxJsonBytes,
      );
      return;
    }

    const authenticatedSession = auth.authenticate(request);
    if (authenticatedSession === undefined) {
      writeError(response, 401, "unauthenticated", "Office session is required.", maxJsonBytes);
      return;
    }

    if (requestUrl.pathname === "/api/v1/audit") {
      const audit = auth.readAudit(authenticatedSession);
      if (audit === undefined) writeError(response, 403, "forbidden", "Owner access is required.", maxJsonBytes);
      else writeJson(response, 200, audit, maxJsonBytes);
      return;
    }

    const historyMatch = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(requestUrl.pathname);
    if (historyMatch !== null) {
      if (runtimeSource === undefined) {
        writeError(response, 503, "runtime_unavailable", "Hermes runtime is unavailable.", maxJsonBytes);
        return;
      }
      try {
        const history = await runtimeSource.chat().fetchHistory({
          sessionId: decodeURIComponent(historyMatch[1]!),
          profile: requestUrl.searchParams.get("profile") ?? "default",
          limit: 200,
          offset: 0,
        });
        writeJson(response, 200, history, maxJsonBytes);
      } catch {
        writeError(response, 502, "runtime_unavailable", "Hermes history is unavailable.", maxJsonBytes);
      }
      return;
    }

    if (requestUrl.pathname === "/api/v1/snapshot") {
      const snapshot = runtimeSource === undefined
        ? createDemoSnapshot()
        : await runtimeSource.snapshot().catch(() => createDemoSnapshot());
      writeJson(response, 200, snapshot, maxJsonBytes);
      return;
    }

    writeError(response, 404, "not_found", "Route not found.", maxJsonBytes);
  });

  httpServer.requestTimeout = 15_000;
  httpServer.headersTimeout = 10_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 64;

  httpServer.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const requestUrl = parseRequestUrl(request.url);
    const isEvents = requestUrl?.pathname === "/api/v1/events";
    const isChat = requestUrl?.pathname === "/api/v1/chat";
    if (!isEvents && !isChat) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const origin = request.headers.origin;
    if (origin === undefined || !originAllowlist.has(normalizeOrigin(origin))) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const authenticatedSession = auth.authenticate(request);
    if (authenticatedSession === undefined) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const targetServer = isChat ? chatWebSocketServer : websocketServer;
    if (targetServer.clients.size >= maxWebSocketClients) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    targetServer.handleUpgrade(request, socket, head, (websocket) => {
      (isChat ? chatSocketPrincipals : eventSocketPrincipals).set(websocket, authenticatedSession.principal.id);
      const expiryDelay = Math.max(1, Date.parse(authenticatedSession.expiresAt) - Date.now());
      const expiryTimer = setTimeout(() => websocket.close(1008, "Session expired"), expiryDelay);
      websocket.once("close", () => clearTimeout(expiryTimer));
      targetServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (websocket) => {
    websocket.on("error", () => {
      // Errors are connection-local; avoid reflecting details to clients.
    });
    websocket.on("message", () => {
      websocket.close(1008, "Event stream is server-to-client only");
    });

    const event = makeEvent(
      ++sequence,
      "runtime.status",
      runtimeSource?.status() ?? createDemoRuntimeStatus(),
    );
    sendBoundedEvent(websocket, event, maxEventBytes);
  });

  chatWebSocketServer.on("connection", (client) => {
    if (runtimeSource === undefined) { client.close(1013, "Hermes runtime unavailable"); return; }
    let chatTransport: ReturnType<HermesRuntimeSource["chat"]>;
    try {
      chatTransport = runtimeSource.chat();
    } catch {
      client.close(1013, "Hermes runtime unavailable");
      return;
    }
    const queued: string[] = [];
    let upstream: Awaited<ReturnType<ReturnType<HermesRuntimeSource["chat"]>["connect"]>> | undefined;
    let closed = false;

    const send = (value: unknown): void => {
      if (client.readyState !== WebSocket.OPEN) return;
      const body = serializeJson(value, maxJsonBytes);
      if (body !== undefined) client.send(body);
    };
    const processFrame = async (body: string): Promise<void> => {
      let frame: unknown;
      try { frame = JSON.parse(body); } catch { client.close(1007, "Invalid JSON"); return; }
      if (!isRpcRequest(frame)) { client.close(1008, "Invalid RPC request"); return; }
      try {
        const seed = frame.method === "session.create"
          ? await runtimeSource.globalInheritance?.().sessionCreateContext()
          : undefined;
        const result = await upstream!.request(
          { method: frame.method, ...(frame.params === undefined ? {} : { params: frame.params }) },
          seed === undefined ? undefined : { sessionCreateSystemSeed: seed },
        );
        send({ jsonrpc: "2.0", id: frame.id, result: result.value });
      } catch {
        send({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "Hermes request failed." } });
      }
    };
    client.on("message", (data, isBinary) => {
      if (isBinary) { client.close(1003, "Text frames only"); return; }
      const body = data.toString();
      if (upstream === undefined) {
        if (queued.length >= 8) client.close(1013, "Chat is starting");
        else queued.push(body);
      } else void processFrame(body);
    });
    client.on("close", () => { closed = true; void upstream?.close(); });
    client.on("error", () => { closed = true; void upstream?.close(); });

    void chatTransport.connect((event) => {
      send({ jsonrpc: "2.0", method: "event", params: event });
    }).then(async (connection) => {
      upstream = connection;
      if (closed) { await connection.close(); return; }
      send({ jsonrpc: "2.0", method: "office.ready", params: {} });
      for (const body of queued.splice(0)) await processFrame(body);
    }).catch(() => client.close(1013, "Hermes chat unavailable"));
  });

  return {
    host,
    port,
    originAllowlist,
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError);
          const address = httpServer.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Office Server did not receive a TCP address."));
            return;
          }
          if (options.allowedOrigins === undefined && isLoopbackHost(host)) {
            originAllowlist.add(`http://127.0.0.1:${address.port}`);
            originAllowlist.add(`http://localhost:${address.port}`);
          }
          resolve(address);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of websocketServer.clients) {
          client.close(1001, "Server shutting down");
        }
        for (const client of chatWebSocketServer.clients) client.close(1001, "Server shutting down");
        websocketServer.close(() => {
          chatWebSocketServer.close(() => {
            httpServer.close((error) => {
              if (error) { reject(error); return; }
              if (runtimeSource === undefined) resolve();
              else runtimeSource.close().then(resolve, reject);
            });
          });
        });
      }),
    broadcast: <T>(topic: EventTopic, payload: T, aggregateId?: string): boolean => {
      const event = makeEvent(++sequence, topic, payload, aggregateId);
      let sent = false;
      for (const client of websocketServer.clients) {
        sent = sendBoundedEvent(client, event, maxEventBytes) || sent;
      }
      return sent;
    },
  };
}

function defaultOriginsForPort(port: number): readonly string[] {
  return [
    ...DEFAULT_ORIGINS,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];
}

function isRpcRequest(value: unknown): value is { id: string | number; method: HermesChatMethod; params?: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.jsonrpc === "2.0" && (typeof frame.id === "string" || typeof frame.id === "number") && typeof frame.method === "string" && HERMES_CHAT_METHODS.includes(frame.method as HermesChatMethod) && (frame.params === undefined || (typeof frame.params === "object" && frame.params !== null && !Array.isArray(frame.params)));
}

export function makeOriginAllowlist(origins: readonly string[]): ReadonlySet<string> {
  const normalized = origins.map(normalizeOrigin);
  if (
    normalized.length === 0 ||
    normalized.some(
      (origin) => origin === "" || origin === "*" || origin === "null",
    )
  ) {
    throw new Error("Origin allowlist must contain explicit, non-null origins.");
  }
  return new Set(normalized);
}

export function normalizeOrigin(origin: string): string {
  const value = origin.trim();
  if (value === "") return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== ""
      ) {
        return "";
      }
      return parsed.origin;
    }
  } catch {
    return value.replace(/\/$/, "");
  }
  return value.replace(/\/$/, "");
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function makeEvent<T>(
  sequence: number,
  topic: EventTopic,
  payload: T,
  aggregateId?: string,
): EventEnvelope<T> {
  return {
    protocolVersion: OFFICE_PROTOCOL_VERSION,
    eventId: `event-${sequence}`,
    topic,
    sequence,
    occurredAt: new Date().toISOString(),
    ...(aggregateId === undefined ? {} : { aggregateId }),
    payload,
  };
}

function sendBoundedEvent(
  websocket: WebSocket,
  event: EventEnvelope,
  maxBytes: number,
): boolean {
  if (websocket.readyState !== WebSocket.OPEN) return false;
  if (websocket.bufferedAmount > maxBytes * 4) {
    websocket.close(1013, "Client is too slow; resync required");
    return false;
  }

  if (hasForbiddenWireKey(event.payload)) return false;
  const body = serializeJson(event, maxBytes);
  if (body === undefined) return false;
  websocket.send(body);
  return true;
}

function parseRequestUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.length > 2_048) return undefined;
  try {
    return new URL(value, "http://office.local");
  } catch {
    return undefined;
  }
}

function requestHasBody(request: import("node:http").IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const declaredLength = request.headers["content-length"];
  if (declaredLength === undefined) return false;
  const length = Number(declaredLength);
  return !Number.isSafeInteger(length) || length > 0;
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function writeStaticWebAsset(
  response: import("node:http").ServerResponse,
  method: "GET" | "HEAD",
  asset: StaticWebAsset,
): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'",
  );
  response.writeHead(200, {
    "Content-Type": asset.contentType,
    "Content-Length": asset.body.byteLength.toString(),
    "Cache-Control": asset.cacheControl,
  });
  response.end(method === "HEAD" ? undefined : asset.body);
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
  maxBytes: number,
  headers: Record<string, string> = {},
): void {
  const body = hasForbiddenWireKey(value) ? undefined : serializeJson(value, maxBytes);
  if (body === undefined) {
    const fallback = '{"code":"internal_error","message":"Response unavailable.","retryable":false}';
    response.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(fallback).toString(),
    });
    response.end(fallback);
    return;
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    ...headers,
  });
  response.end(body);
}

function writeError(
  response: import("node:http").ServerResponse,
  status: number,
  code: ProtocolError["code"],
  message: string,
  maxBytes: number,
  headers: Record<string, string> = {},
): void {
  const error: ProtocolError = { code, message, retryable: false };
  writeJson(response, status, error, maxBytes, headers);
}

function applySecurityHeaders(response: import("node:http").ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function serializeJson(value: unknown, maxBytes: number): string | undefined {
  try {
    const body = JSON.stringify(value);
    return body !== undefined && Buffer.byteLength(body) <= maxBytes ? body : undefined;
  } catch {
    return undefined;
  }
}

function hasForbiddenWireKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
    if (
      normalizedKey === "secret" ||
      normalizedKey === "secretvalue" ||
      normalizedKey === "password" ||
      normalizedKey === "authorization" ||
      normalizedKey === "token" ||
      normalizedKey === "accesstoken" ||
      normalizedKey === "refreshtoken" ||
      normalizedKey === "apikey" ||
      normalizedKey === "credential" ||
      normalizedKey === "credentials" ||
      normalizedKey === "environment"
    ) {
      return true;
    }
    if (hasForbiddenWireKey(child, seen)) return true;
  }
  return false;
}

function rejectUpgrade(
  socket: import("node:stream").Duplex,
  status: number,
  reason: string,
): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
