import type { OfficeRuntimeState, OfficeSnapshot } from "./domain";
import { classifyDeviceLoginFailure, isLocalOfficeClient, normalizeDeviceName, type DeviceLoginFailure } from "./auth-state";
import { createAuthenticatedOfficeWebSocket, desktopCapability, desktopCapabilityHeader } from "./desktop-transport";

type HealthResponse = {
  ok: true;
  protocolVersion: number;
  runtime: OfficeRuntimeState;
};

export type OfficeEvent = {
  topic: string;
  sequence: number;
  payload?: unknown;
};

export type OfficeApiCallbacks = {
  onConnecting(serverUrl: string): void;
  onSnapshot(snapshot: OfficeSnapshot, serverUrl: string): void;
  onEventStream(state: "closed" | "connecting" | "open"): void;
  onError(message: string, serverUrl: string): void;
  onAuthRequired?(serverUrl: string): void;
  onEvent?(event: OfficeEvent): void;
};

export type OfficeApiConnection = { stop(): void; retry(): void };

export type OfficeApiRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  body?: unknown;
  timeoutMs?: number;
};

export type DeviceLoginResult = { ok: true } | ({ ok: false } & DeviceLoginFailure);

export class OfficeDeviceAuthRequiredError extends Error {
  constructor() {
    super("Remote device authentication is required.");
    this.name = "OfficeDeviceAuthRequiredError";
  }
}

// A cold Hermes snapshot can legitimately take several seconds while its
// profile/session indexes initialize. Keep the UI responsive, but do not
// drop into demo fallback during a normal first launch.
const FETCH_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 3_000;
type OfficeClientSession = { csrfToken: string; desktopCapability?: string };
const officeSessions = new Map<string, Promise<OfficeClientSession>>();
const officeSessionRefreshes = new Map<string, Promise<OfficeClientSession>>();
let authRequiredObserver: ((serverUrl: string) => void) | undefined;

export function officeServerUrl(): string {
  const configured = import.meta.env.VITE_OFFICE_SERVER_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (location.protocol === "tauri:" || location.hostname === "tauri.localhost") {
    return "http://127.0.0.1:4317";
  }
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return `${location.protocol}//${location.hostname}:4317`;
  }
  return location.origin;
}

export function connectOfficeApi(callbacks: OfficeApiCallbacks): OfficeApiConnection {
  const serverUrl = officeServerUrl();
  authRequiredObserver = callbacks.onAuthRequired;
  let stopped = false;
  let socket: WebSocket | undefined;
  let eventStreamOpening = false;
  let reconnectTimer: number | undefined;
  let refreshTimer: number | undefined;

  const stopSocket = () => {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    reconnectTimer = undefined;
    refreshTimer = undefined;
    socket?.close(1000, "Client stopped");
    socket = undefined;
    callbacks.onEventStream("closed");
  };

  const loadSnapshot = async (showConnecting: boolean) => {
    if (showConnecting) callbacks.onConnecting(serverUrl);
    try {
      const health = await officeFetchJson<HealthResponse>("/api/v1/health", {}, serverUrl);
      if (!isHealthResponse(health)) throw new Error("Office Server health response is incompatible.");
      const snapshot = await officeFetchJson<OfficeSnapshot>("/api/v1/snapshot", {}, serverUrl);
      if (!isOfficeSnapshot(snapshot)) throw new Error("Office Server snapshot is incompatible.");
      if (snapshot.capabilities.protocolVersion !== health.protocolVersion) {
        throw new Error("Office Server protocol versions do not match.");
      }
      callbacks.onSnapshot(snapshot, serverUrl);
      return true;
    } catch (error) {
      if (error instanceof OfficeDeviceAuthRequiredError) {
        if (!stopped) callbacks.onAuthRequired?.(serverUrl);
        return false;
      }
      if (!stopped) callbacks.onError(errorMessage(error), serverUrl);
      return false;
    }
  };

  const scheduleSnapshotRefresh = () => {
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void loadSnapshot(false), 120);
  };

  const openEvents = async () => {
    if (stopped || socket || eventStreamOpening) return;
    eventStreamOpening = true;
    callbacks.onEventStream("connecting");
    let nextSocket: WebSocket;
    try {
      nextSocket = await createAuthenticatedOfficeWebSocket(toWebSocketUrl(serverUrl));
    } catch (error) {
      eventStreamOpening = false;
      callbacks.onEventStream("closed");
      callbacks.onError(errorMessage(error), serverUrl);
      if (!stopped) reconnectTimer = window.setTimeout(() => void openEvents(), RECONNECT_DELAY_MS);
      return;
    }
    eventStreamOpening = false;
    if (stopped || socket) { nextSocket.close(1000, "Client stopped"); return; }
    socket = nextSocket;
    socket.addEventListener("open", () => callbacks.onEventStream("open"));
    socket.addEventListener("message", (event) => {
      const message = parseEvent(event.data);
      if (!message) return;
      callbacks.onEvent?.(message);
      if (message.topic === "resync.required" || message.topic.endsWith(".changed") || message.topic === "runtime.status") {
        scheduleSnapshotRefresh();
      }
    });
    socket.addEventListener("close", () => {
      socket = undefined;
      callbacks.onEventStream("closed");
      if (!stopped) reconnectTimer = window.setTimeout(() => void openEvents(), RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", () => socket?.close());
  };

  const start = async () => {
    stopSocket();
    const available = await loadSnapshot(true);
    if (available && !stopped) void openEvents();
  };

  void start();
  return {
    stop() {
      stopped = true;
      stopSocket();
    },
    retry() {
      stopped = false;
      void start();
    }
  };
}

export async function officeFetchJson<T>(path: string, options: OfficeApiRequestOptions = {}, serverUrl = officeServerUrl()): Promise<T> {
  const baseUrl = new URL(serverUrl);
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/api/v1/")) {
    throw new Error("Office API path is invalid.");
  }
  try {
    const session = await ensureOfficeSession(serverUrl);
    return await requestOfficeJson<T>(url, options, session, serverUrl, true);
  } catch (error) {
    if (error instanceof OfficeDeviceAuthRequiredError) authRequiredObserver?.(serverUrl);
    throw error;
  }
}

/**
 * Starts a one-shot device login. The credential is serialized directly into
 * the request body and is never placed in module state, signals, URLs, or logs.
 */
export function authenticateRemoteDevice(deviceNameInput: string, credential: string, serverUrl = officeServerUrl()): Promise<DeviceLoginResult> {
  const deviceName = normalizeDeviceName(deviceNameInput);
  if (!deviceName) return Promise.resolve({ ok: false, ...classifyDeviceLoginFailure(400, null) });
  const request = fetch(`${serverUrl}/api/v1/auth/device`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ token: credential, deviceName })
  });
  return request.then(async (response): Promise<DeviceLoginResult> => {
    if (!response.ok) return { ok: false, ...classifyDeviceLoginFailure(response.status, response.headers.get("Retry-After")) };
    const session = parseOfficeSession(await response.json() as unknown);
    if (!session) return { ok: false, ...classifyDeviceLoginFailure(500, null) };
    officeSessions.set(serverUrl, Promise.resolve(session));
    return { ok: true };
  }, (): DeviceLoginResult => ({ ok: false, ...classifyDeviceLoginFailure(0, null) }));
}

export async function logoutRemoteDevice(serverUrl = officeServerUrl()): Promise<void> {
  await officeFetchJson<{ ok: true }>("/api/v1/auth/logout", { method: "POST" }, serverUrl);
  officeSessions.delete(serverUrl);
  officeSessionRefreshes.delete(serverUrl);
}

async function requestOfficeJson<T>(url: URL, options: OfficeApiRequestOptions, session: OfficeClientSession, serverUrl: string, retryAuth: boolean): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const method = options.method ?? "GET";
  try {
    const response = await fetch(url, {
      method,
      credentials: "include",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...desktopCapabilityHeader(session.desktopCapability),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "GET" || session.desktopCapability !== undefined ? {} : { "X-CSRF-Token": session.csrfToken })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    if (response.status === 401 && retryAuth) {
      const replacement = await recoverOfficeSession(serverUrl, session.csrfToken);
      return await requestOfficeJson<T>(url, options, replacement, serverUrl, false);
    }
    if (!response.ok) throw new Error(`Office Server returned HTTP ${response.status}.`);
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

function ensureOfficeSession(serverUrl: string): Promise<OfficeClientSession> {
  const current = officeSessions.get(serverUrl);
  if (current) return current;
  const pending = bootstrapLocalSession(serverUrl).catch((error) => {
    if (officeSessions.get(serverUrl) === pending) officeSessions.delete(serverUrl);
    throw error;
  });
  officeSessions.set(serverUrl, pending);
  return pending;
}

function refreshOfficeSession(serverUrl: string): Promise<OfficeClientSession> {
  const current = officeSessionRefreshes.get(serverUrl);
  if (current) return current;
  officeSessions.delete(serverUrl);
  const pending = ensureOfficeSession(serverUrl);
  officeSessionRefreshes.set(serverUrl, pending);
  void pending.then(
    () => { if (officeSessionRefreshes.get(serverUrl) === pending) officeSessionRefreshes.delete(serverUrl); },
    () => { if (officeSessionRefreshes.get(serverUrl) === pending) officeSessionRefreshes.delete(serverUrl); }
  );
  return pending;
}

async function recoverOfficeSession(serverUrl: string, rejectedCsrfToken: string): Promise<OfficeClientSession> {
  const current = officeSessions.get(serverUrl);
  if (current) {
    const session = await current;
    if (session.csrfToken !== rejectedCsrfToken) return session;
  }
  return await refreshOfficeSession(serverUrl);
}

async function bootstrapLocalSession(serverUrl: string): Promise<OfficeClientSession> {
  const capability = await desktopCapability();
  if (capability !== undefined) return { csrfToken: "desktop-capability", desktopCapability: capability };
  const response = await fetch(`${serverUrl}/api/v1/auth/local`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" }
  });
  if (response.status === 403 && !isLocalOfficeClient(location)) {
    const renewal = await fetch(`${serverUrl}/api/v1/auth/device/renew`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (renewal.ok) {
      const renewed = parseOfficeSession(await renewal.json() as unknown);
      if (renewed) return renewed;
    }
    throw new OfficeDeviceAuthRequiredError();
  }
  if (!response.ok) throw new Error(`Office local authentication failed with HTTP ${response.status}.`);
  const body = await response.json() as unknown;
  const session = parseOfficeSession(body);
  if (!session) throw new Error("Office local authentication response is incompatible.");
  return session;
}

function parseOfficeSession(value: unknown): { csrfToken: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const csrfToken = (value as { csrfToken?: unknown }).csrfToken;
  return typeof csrfToken === "string" && csrfToken.length >= 16 && csrfToken.length <= 512
    ? { csrfToken }
    : undefined;
}

function toWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/events";
  url.search = "";
  return url.toString();
}

function parseEvent(data: unknown): OfficeEvent | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const value = JSON.parse(data) as Partial<OfficeEvent>;
    if (typeof value.topic !== "string" || typeof value.sequence !== "number") return undefined;
    return value as OfficeEvent;
  } catch {
    return undefined;
  }
}

function isHealthResponse(value: unknown): value is HealthResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HealthResponse>;
  return candidate.ok === true && typeof candidate.protocolVersion === "number" && typeof candidate.runtime === "string";
}

export function isOfficeSnapshot(value: unknown): value is OfficeSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OfficeSnapshot>;
  return typeof candidate.generatedAt === "string"
    && typeof candidate.sequence === "number"
    && Array.isArray(candidate.profiles)
    && Array.isArray(candidate.sessions)
    && Array.isArray(candidate.boards)
    && typeof candidate.capabilities?.protocolVersion === "number"
    && typeof candidate.capabilities.runtime?.state === "string"
    && isOfficeAccess(candidate.capabilities.access);
}

function isOfficeAccess(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const access = value as Record<string, unknown>;
  return typeof access.deviceId === "string" && access.deviceId.length > 0 && access.deviceId.length <= 128
    && ["viewer", "operator", "manager", "owner"].includes(String(access.tier))
    && ["loopback", "tailnet", "public"].includes(String(access.exposure))
    && ["desktop-capability", "local-cookie", "device-cookie", "tailscale-identity", "oidc"].includes(String(access.authentication))
    && Array.isArray(access.allowedOperations)
    && access.allowedOperations.length <= 128
    && access.allowedOperations.every((operation) => typeof operation === "string" && operation.length > 0 && operation.length <= 80);
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Office Serverへの接続がタイムアウトしました。";
  if (error instanceof Error) return error.message;
  return "Office Serverへ接続できませんでした。";
}
