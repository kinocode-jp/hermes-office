import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { EventEnvelope, EventTopic, ProtocolError } from "@hermes-office/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
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
  const originAllowlist = makeOriginAllowlist(options.allowedOrigins ?? DEFAULT_ORIGINS);
  const runtimeSource = options.runtimeSource;

  if (!options.allowNonLoopback && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing non-loopback bind (${host}) without allowNonLoopback. Configure authentication first.`,
    );
  }

  let sequence = 0;
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxJsonBytes,
    perMessageDeflate: false,
    clientTracking: true,
  });

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

    if (requestHasBody(request)) {
      request.resume();
      response.setHeader("Connection", "close");
      writeError(response, 413, "bad_request", "Request bodies are not accepted.", maxJsonBytes);
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }

    if (request.method !== "GET") {
      writeError(response, 405, "bad_request", "Method not allowed.", maxJsonBytes, {
        Allow: "GET, OPTIONS",
      });
      return;
    }

    const requestUrl = parseRequestUrl(request.url);
    if (requestUrl === undefined) {
      writeError(response, 400, "bad_request", "Malformed request URL.", maxJsonBytes);
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
    if (requestUrl?.pathname !== "/api/v1/events") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const origin = request.headers.origin;
    if (origin === undefined || !originAllowlist.has(normalizeOrigin(origin))) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    if (websocketServer.clients.size >= maxWebSocketClients) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
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
          resolve(address);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of websocketServer.clients) {
          client.close(1001, "Server shutting down");
        }
        websocketServer.close(() => {
          httpServer.close((error) => {
            if (error) { reject(error); return; }
            if (runtimeSource === undefined) resolve();
            else runtimeSource.close().then(resolve, reject);
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
