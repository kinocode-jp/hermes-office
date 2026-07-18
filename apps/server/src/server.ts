import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { EventEnvelope, EventTopic, Operation, ProtocolError } from "@hermes-office/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { OfficeAuth, type OfficeAuditRecord } from "./office-auth.js";
import { isKanbanHttpPath, isKanbanMutation, routeKanbanHttp } from "./kanban-http.js";
import { isSettingsHttpPath, isSettingsMutation, routeSettingsHttp } from "./settings-http.js";
import { DeviceAuthBodyError, readDeviceAuthBody } from "./device-auth-http.js";
import { ChatDeviceRateLimiter, handleOfficeChatConnection } from "./chat-gateway.js";
import { createChatSocketAuthGuard, invalidateChatSocket, type ChatSocketAuthGuard } from "./chat-socket-auth.js";
import { ChatSessionCoordinator } from "./chat-session-coordinator.js";
import { ChatUpstreamHub } from "./chat-upstream-hub.js";
import { fetchOfficeHistoryPage, HistoryHttpInputError } from "./history-http.js";
import { routeInventoryHttp } from "./inventory-http.js";
import { StaticWebAssets, type StaticWebAsset } from "./static-web.js";
import {
  OFFICE_PROTOCOL_VERSION,
  createDemoRuntimeStatus,
  createDemoSnapshot,
} from "./demo-state.js";
import { DEFAULT_OFFICE_ORIGINS, listenerOrigins } from "./server-origins.js";

export interface OfficeServerOptions {
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  allowNonLoopback?: boolean;
  trustedProxyHops?: number;
  deviceRegistryPath?: string;
  maxJsonBytes?: number;
  maxResponseJsonBytes?: number;
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
  const maxResponseJsonBytes = boundedInteger(options.maxResponseJsonBytes, 4 * 1024 * 1024, 1024 * 1024, 8 * 1024 * 1024);
  const maxEventBytes = boundedInteger(options.maxEventBytes, 64 * 1024, 1_024, 1024 * 1024);
  const maxWebSocketClients = boundedInteger(options.maxWebSocketClients, 32, 1, 256);
  const effectiveDesktopOrigins = options.desktopOrigins ?? DEFAULT_OFFICE_ORIGINS;
  const originAllowlist = new Set(makeOriginAllowlist([...(options.allowedOrigins ?? DEFAULT_OFFICE_ORIGINS), ...effectiveDesktopOrigins]));
  const runtimeSource = options.runtimeSource;
  const staticWeb = options.staticWebRoot === undefined ? undefined : new StaticWebAssets(options.staticWebRoot);
  let publishAudit = (_record: OfficeAuditRecord): void => {};
  const auth = new OfficeAuth({
    ...(options.remoteToken === undefined ? {} : { remoteToken: options.remoteToken }),
    ...(options.desktopCapability === undefined ? {} : { desktopCapability: options.desktopCapability }),
    desktopOrigins: effectiveDesktopOrigins,
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.trustedProxyHops === undefined ? {} : { trustedProxyHops: options.trustedProxyHops }),
    ...(options.deviceRegistryPath === undefined ? {} : { deviceRegistryPath: options.deviceRegistryPath }),
    onAudit: (record) => publishAudit(record),
  });

  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing direct non-loopback bind (${host}); use a trusted HTTPS reverse proxy to the loopback listener.`);
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
  const eventSocketSessions = new WeakMap<WebSocket, import("./office-auth.js").OfficeAuthSession>();
  const chatSocketPrincipals = new WeakMap<WebSocket, string>();
  const chatSocketSessions = new WeakMap<WebSocket, import("./office-auth.js").OfficeAuthSession>();
  const chatSocketAuthGuards = new WeakMap<WebSocket, ChatSocketAuthGuard>();
  const chatDeviceLimiter = new ChatDeviceRateLimiter();
  const chatSessionCoordinator = new ChatSessionCoordinator();
  const chatUpstreamHub = runtimeSource === undefined ? undefined : new ChatUpstreamHub(runtimeSource, chatSessionCoordinator, maxJsonBytes);
  const publishRuntimeStatus = (status: import("@hermes-office/protocol").RuntimeStatus): void => {
    const event = makeEvent(++sequence, "runtime.status", status);
    for (const client of websocketServer.clients) sendBoundedEvent(client, event, maxEventBytes);
  };
  const unsubscribeRuntimeStatus = runtimeSource?.onStatusChange?.(publishRuntimeStatus);
  publishAudit = (record) => {
    const publicRecord = {
      occurredAt: record.occurredAt,
      operation: record.operation,
      outcome: record.outcome,
      deviceName: record.deviceName,
      local: record.local,
    };
    const event = makeEvent(++sequence, "access.changed", { audit: publicRecord });
    for (const client of websocketServer.clients) {
      const session = eventSocketSessions.get(client);
      if (session !== undefined && auth.authorizeSession(session, "audit.read").allowed) {
        sendBoundedEvent(client, event, maxEventBytes);
      }
    }
    if (record.operation === "auth.logout" && record.actorId !== null) {
      for (const client of websocketServer.clients) {
        if (eventSocketPrincipals.get(client) === record.actorId) client.close(1008, "Session revoked");
      }
      for (const client of chatWebSocketServer.clients) {
        if (chatSocketPrincipals.get(client) === record.actorId) {
          invalidateChatSocket(client, chatSocketAuthGuards);
          client.close(1008, "Session revoked");
        }
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
      else writeJson(response, 200, session, maxResponseJsonBytes);
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
        const result = await auth.bootstrapDevice(request, response, credentials);
        if (result.outcome === "success") writeJson(response, 200, result.session, maxResponseJsonBytes);
        else if (result.outcome === "rate_limited") {
          writeError(response, 429, "rate_limited", "Too many device authentication attempts.", maxJsonBytes, { "Retry-After": "60" });
        } else if (result.outcome === "insecure_transport") {
          writeError(response, 403, "forbidden", "Remote enrollment requires a configured trusted HTTPS proxy.", maxJsonBytes);
        } else if (result.outcome === "enrollment_consumed") {
          writeError(response, 409, "conflict", "The one-time enrollment token has already been used.", maxJsonBytes);
        } else if (result.outcome === "storage_unavailable") {
          writeError(response, 503, "internal_error", "Device enrollment could not be persisted.", maxJsonBytes);
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

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/auth/device/renew") {
      if (requestHasBody(request)) { request.resume(); writeError(response, 413, "bad_request", "Renewal request bodies are not accepted.", maxJsonBytes); return; }
      const result = auth.renewDevice(request, response);
      if (result.outcome === "success") writeJson(response, 200, result.session, maxResponseJsonBytes);
      else if (result.outcome === "rate_limited") writeError(response, 429, "rate_limited", "Too many device renewal attempts.", maxJsonBytes, { "Retry-After": "60" });
      else if (result.outcome === "insecure_transport") writeError(response, 403, "forbidden", "Remote renewal requires a configured trusted HTTPS proxy.", maxJsonBytes);
      else writeError(response, 401, "unauthenticated", "Device credential is invalid or revoked.", maxJsonBytes);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/auth/logout") {
      if (requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "Logout request bodies are not accepted.", maxJsonBytes);
      } else if (auth.authenticate(request) === undefined) {
        writeError(response, 401, "unauthenticated", "Office session is not active.", maxJsonBytes);
      } else if (!auth.authorizeOperation(request, "state.read", true).allowed) {
        writeError(response, 403, "forbidden", "A valid Office session and CSRF token are required.", maxJsonBytes);
      } else if (!await auth.revoke(request, response)) {
        writeError(response, 401, "unauthenticated", "Office session is not active.", maxJsonBytes);
      } else {
        writeJson(response, 200, { ok: true }, maxResponseJsonBytes);
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
      const access = auth.authorizeOperation(request, kanbanOperation(request.method, requestUrl.pathname), isKanbanMutation(request.method));
      if (!access.allowed) { request.resume(); writeAuthorizationError(response, access.reason, maxJsonBytes); return; }
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
        writeJson(response, result.status, result.body, maxResponseJsonBytes, result.headers ?? {});
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
      const access = auth.authorizeOperation(request, settingsOperation(request.method, requestUrl.pathname), isSettingsMutation(request.method));
      if (!access.allowed) { request.resume(); writeAuthorizationError(response, access.reason, maxJsonBytes); return; }
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
      writeJson(response, result.status, result.body, maxResponseJsonBytes, result.headers ?? {});
      if (result.changed !== undefined && result.status >= 200 && result.status < 300) {
        const aggregateId = result.changed.profile ?? result.changed.id ?? "global";
        const event = makeEvent(++sequence, "profile.changed", result.changed, aggregateId);
        for (const client of websocketServer.clients) sendBoundedEvent(client, event, maxEventBytes);
      }
      return;
    }

    const revokeDeviceMatch = /^\/api\/v1\/devices\/([^/]+)\/revoke$/.exec(requestUrl.pathname);
    if (request.method === "POST" && revokeDeviceMatch !== null) {
      if (requestHasBody(request)) { request.resume(); writeError(response, 413, "bad_request", "Device revocation request bodies are not accepted.", maxJsonBytes); return; }
      // SECURITY: POST device revoke is intentionally local-owner + CSRF, not
      // desktop-exclusive. It forms a trusted loopback recovery boundary so the
      // owner can revoke devices even if the Tauri desktop bridge is unavailable.
      // This path is not exposed to remote devices and is not weakened by
      // removing or bypassing CSRF.
      const access = auth.authorizeOperation(request, "device.revoke", true);
      if (!access.allowed) { writeAuthorizationError(response, access.reason, maxJsonBytes); return; }
      let deviceId: string;
      try { deviceId = decodeURIComponent(revokeDeviceMatch[1]!); }
      catch { writeError(response, 400, "bad_request", "Device identifier is malformed.", maxJsonBytes); return; }
      if (!await auth.revokeDevice(access.session, deviceId)) { writeError(response, 404, "not_found", "Active device was not found.", maxJsonBytes); return; }
      for (const client of websocketServer.clients) if (eventSocketPrincipals.get(client) === deviceId) client.close(1008, "Device revoked");
      for (const client of chatWebSocketServer.clients) if (chatSocketPrincipals.get(client) === deviceId) {
        invalidateChatSocket(client, chatSocketAuthGuards);
        client.close(1008, "Device revoked");
      }
      writeJson(response, 200, { ok: true }, maxResponseJsonBytes);
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
        maxResponseJsonBytes,
      );
      return;
    }

    const readAccess = auth.authorizeOperation(request, "state.read", false);
    if (!readAccess.allowed) {
      writeAuthorizationError(response, readAccess.reason, maxJsonBytes);
      return;
    }
    const authenticatedSession = readAccess.session;

    if (requestUrl.pathname === "/api/v1/audit") {
      const auditAccess = auth.authorizeOperation(request, "audit.read", false);
      const audit = auditAccess.allowed ? auth.readAudit(auditAccess.session) : undefined;
      if (audit === undefined) writeError(response, 403, "forbidden", "Owner access is required.", maxJsonBytes);
      else writeJson(response, 200, audit, maxResponseJsonBytes);
      return;
    }

    // Remote-device management routes are local-owner only.
    if (requestUrl.pathname === "/api/v1/devices") {
      const deviceAccess = auth.authorizeOperation(request, "device.revoke", false);
      const devices = deviceAccess.allowed ? auth.listDevices(deviceAccess.session) : undefined;
      if (devices === undefined) writeError(response, 403, "forbidden", "Verified local owner access is required.", maxJsonBytes);
      else writeJson(response, 200, devices, maxResponseJsonBytes);
      return;
    }

    if (requestUrl.pathname === "/api/v1/host/remote") {
      const config = auth.remoteConfig(authenticatedSession);
      if (config === undefined) writeError(response, 403, "forbidden", "Verified local desktop owner access is required.", maxJsonBytes);
      else writeJson(response, 200, config, maxResponseJsonBytes);
      return;
    }

    if (requestUrl.pathname === "/api/v1/inventory") {
      const result = await routeInventoryHttp(runtimeSource, requestUrl);
      writeJson(response, result.status, result.body, maxResponseJsonBytes);
      return;
    }

    const historyMatch = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(requestUrl.pathname);
    if (historyMatch !== null) {
      if (runtimeSource === undefined) {
        writeError(response, 503, "runtime_unavailable", "Hermes runtime is unavailable.", maxJsonBytes);
        return;
      }
      let sessionId: string;
      try { sessionId = decodeURIComponent(historyMatch[1]!); }
      catch { writeError(response, 400, "bad_request", "Session identifier is malformed.", maxJsonBytes); return; }
      try {
        const history = await chatUpstreamHub!.readStableHistory(async () => await fetchOfficeHistoryPage(
          runtimeSource.chat(), requestUrl, sessionId, maxResponseJsonBytes,
        ));
        writeJson(response, 200, history, maxResponseJsonBytes);
      } catch (error) {
        if (error instanceof HistoryHttpInputError) {
          writeError(response, 400, "bad_request", error.message, maxJsonBytes);
          return;
        }
        writeError(response, 502, "runtime_unavailable", "Hermes history is unavailable.", maxJsonBytes);
      }
      return;
    }

    if (requestUrl.pathname === "/api/v1/snapshot") {
      const snapshot = runtimeSource === undefined
        ? createDemoSnapshot()
        : await runtimeSource.snapshot().catch(() => createDemoSnapshot());
      writeJson(response, 200, {
        ...snapshot,
        capabilities: { ...snapshot.capabilities, access: auth.effectiveAccess(authenticatedSession) },
      }, maxResponseJsonBytes);
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
      if (isChat) chatSocketSessions.set(websocket, authenticatedSession);
      else eventSocketSessions.set(websocket, authenticatedSession);
      if (isChat) chatSocketAuthGuards.set(websocket, createChatSocketAuthGuard(auth, request, authenticatedSession));
      const expiryDelay = Math.max(1, Date.parse(authenticatedSession.expiresAt) - Date.now());
      const expiryTimer = setTimeout(() => {
        if (isChat) invalidateChatSocket(websocket, chatSocketAuthGuards);
        websocket.close(1008, "Session expired");
      }, expiryDelay);
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
    if (runtimeSource === undefined || chatUpstreamHub === undefined) { client.close(1013, "Hermes runtime unavailable"); return; }
    const officeSession = chatSocketSessions.get(client);
    const authGuard = chatSocketAuthGuards.get(client);
    if (officeSession === undefined || authGuard === undefined) { client.close(1008, "Office session unavailable"); return; }
    handleOfficeChatConnection(client, {
      auth, officeSession, runtimeSource, maxJsonBytes, deviceLimiter: chatDeviceLimiter, sessionCoordinator: chatSessionCoordinator, chatHub: chatUpstreamHub,
      sessionIsActive: authGuard.isActive, invalidationSignal: authGuard.signal,
    });
  });

  return {
    host,
    port,
    originAllowlist,
    listen: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError);
          const address = httpServer.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Office Server did not receive a TCP address."));
            return;
          }
          for (const origin of listenerOrigins(address)) originAllowlist.add(origin);
          resolve(address);
        });
      }),
    close: () => {
      unsubscribeRuntimeStatus?.();
      const runtimeClose = runtimeSource?.close();
      const serverClose = new Promise<void>((resolve, reject) => {
        for (const client of websocketServer.clients) {
          client.close(1001, "Server shutting down");
        }
        for (const client of chatWebSocketServer.clients) client.close(1001, "Server shutting down");
        websocketServer.close(() => {
          chatWebSocketServer.close(() => {
            httpServer.close((error) => {
              if (error) { reject(error); return; }
              resolve();
            });
          });
        });
      }).then(async () => {
        await chatUpstreamHub?.close();
        await auth.flushRegistryWrites();
      });
      return Promise.all([serverClose, runtimeClose]).then(() => undefined);
    },
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

function kanbanOperation(method: string | undefined, pathname: string): Operation {
  if (method === "POST" && pathname.endsWith("/comments")) return "kanban.card.comment";
  if (method === "POST") return "kanban.card.create";
  if (method === "PATCH") return "kanban.card.update";
  return "state.read";
}

function settingsOperation(method: string | undefined, pathname: string): Operation {
  if (method === "GET") return "state.read";
  if (pathname === "/api/v1/settings/global") return "global-settings.update";
  if (/\/skills\/[^/]+\/content$/.test(pathname)) return "skill.install";
  if (/\/skills\/[^/]+$/.test(pathname)) return "skill.enable";
  if (pathname.endsWith("/soul")) return "profile.update";
  if (pathname.includes("/memory/")) return "memory.update";
  return "profile.update";
}

function writeAuthorizationError(
  response: import("node:http").ServerResponse,
  reason: "unauthenticated" | "csrf" | "tier" | "step_up_required" | "local_only",
  maxBytes: number,
): void {
  if (reason === "unauthenticated") {
    writeError(response, 401, "unauthenticated", "Office session is required.", maxBytes);
    return;
  }
  const message = reason === "csrf" ? "A valid CSRF token is required."
    : reason === "step_up_required" ? "This operation requires verified local access because remote step-up is not available."
      : reason === "local_only" ? "This operation is local-only."
        : "The device permission tier does not allow this operation.";
  writeError(response, 403, "forbidden", message, maxBytes);
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
