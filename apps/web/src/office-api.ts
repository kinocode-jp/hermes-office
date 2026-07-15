import type { OfficeRuntimeState, OfficeSnapshot } from "./domain";

type HealthResponse = {
  ok: true;
  protocolVersion: number;
  runtime: OfficeRuntimeState;
};

type OfficeEvent = {
  topic: string;
  sequence: number;
  payload?: unknown;
};

export type OfficeApiCallbacks = {
  onConnecting(serverUrl: string): void;
  onSnapshot(snapshot: OfficeSnapshot, serverUrl: string): void;
  onEventStream(state: "closed" | "connecting" | "open"): void;
  onError(message: string, serverUrl: string): void;
};

export type OfficeApiConnection = { stop(): void; retry(): void };

const FETCH_TIMEOUT_MS = 2_500;
const RECONNECT_DELAY_MS = 3_000;

export function officeServerUrl(): string {
  const configured = import.meta.env.VITE_OFFICE_SERVER_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:4317";
  }
  return location.origin;
}

export function connectOfficeApi(callbacks: OfficeApiCallbacks): OfficeApiConnection {
  const serverUrl = officeServerUrl();
  let stopped = false;
  let socket: WebSocket | undefined;
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
      const health = await fetchJson<HealthResponse>(`${serverUrl}/api/v1/health`);
      if (!isHealthResponse(health)) throw new Error("Office Server health response is incompatible.");
      const snapshot = await fetchJson<OfficeSnapshot>(`${serverUrl}/api/v1/snapshot`);
      if (!isOfficeSnapshot(snapshot)) throw new Error("Office Server snapshot is incompatible.");
      if (snapshot.capabilities.protocolVersion !== health.protocolVersion) {
        throw new Error("Office Server protocol versions do not match.");
      }
      callbacks.onSnapshot(snapshot, serverUrl);
      return true;
    } catch (error) {
      if (!stopped) callbacks.onError(errorMessage(error), serverUrl);
      return false;
    }
  };

  const scheduleSnapshotRefresh = () => {
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void loadSnapshot(false), 120);
  };

  const openEvents = () => {
    if (stopped) return;
    callbacks.onEventStream("connecting");
    socket = new WebSocket(toWebSocketUrl(serverUrl));
    socket.addEventListener("open", () => callbacks.onEventStream("open"));
    socket.addEventListener("message", (event) => {
      const message = parseEvent(event.data);
      if (!message) return;
      if (message.topic === "resync.required" || message.topic.endsWith(".changed") || message.topic === "runtime.status") {
        scheduleSnapshotRefresh();
      }
    });
    socket.addEventListener("close", () => {
      socket = undefined;
      callbacks.onEventStream("closed");
      if (!stopped) reconnectTimer = window.setTimeout(openEvents, RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", () => socket?.close());
  };

  const start = async () => {
    stopSocket();
    const available = await loadSnapshot(true);
    if (available && !stopped) openEvents();
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

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Office Server returned HTTP ${response.status}.`);
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
  }
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

function isOfficeSnapshot(value: unknown): value is OfficeSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OfficeSnapshot>;
  return typeof candidate.generatedAt === "string"
    && typeof candidate.sequence === "number"
    && Array.isArray(candidate.profiles)
    && Array.isArray(candidate.sessions)
    && Array.isArray(candidate.boards)
    && typeof candidate.capabilities?.protocolVersion === "number"
    && typeof candidate.capabilities.runtime?.state === "string";
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Office Serverへの接続がタイムアウトしました。";
  if (error instanceof Error) return error.message;
  return "Office Serverへ接続できませんでした。";
}
