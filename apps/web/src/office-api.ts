import { OPERATION_POLICIES } from "@hermes-office/protocol";
import type { RemoteConfigStatus } from "@hermes-office/protocol";
import type { OfficeRuntimeState, OfficeSnapshot, OfficeSnapshotRequestIdentity } from "./domain";
import { classifyDeviceLoginFailure, isLocalOfficeClient, normalizeDeviceName, type DeviceLoginFailure } from "./auth-state";
import { createAuthenticatedOfficeWebSocket, desktopCapability, desktopCapabilityHeader } from "./desktop-transport";
import {
  beginOfficeSynchronization as beginSynchronizationBarrier,
  rejectOfficeSynchronization as rejectSynchronizationBarrier,
  resolveOfficeSynchronization,
  subscribeOfficeSynchronizationRequests,
  waitForOfficeSynchronization,
} from "./office-synchronization";

export { subscribeOfficeSessionSynchronizations } from "./office-synchronization";

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
  onSnapshot(snapshot: OfficeSnapshot, identity: OfficeSnapshotRequestIdentity): void;
  onEventStream(state: "closed" | "connecting" | "open"): void;
  onError(message: string, serverUrl: string): void;
  onRecoveryUnavailable?(message: string, serverUrl: string): void;
  onAuthRequired?(serverUrl: string): void;
  onEvent?(event: OfficeEvent): void;
};

export type OfficeApiConnection = {
  stop(): void;
  retry(): void;
  refresh(expected?: Pick<OfficeSnapshotRequestIdentity, "serverUrl" | "connectionGeneration">): Promise<OfficeSnapshotRequestIdentity | undefined>;
};

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

export class OfficeSessionUnavailableError extends Error {
  constructor(message: string, readonly retryAfterMs = 0, readonly retryAutomatically = true) {
    super(message);
    this.name = "OfficeSessionUnavailableError";
  }
}

function beginOfficeSynchronization(serverUrl: string, authRevision: number): void {
  beginSynchronizationBarrier(
    serverUrl,
    authRevision,
    new OfficeSessionUnavailableError("Office recovery was superseded.", 0, false),
  );
}

function rejectOfficeSynchronization(serverUrl: string, authRevision: number, message: string): void {
  rejectSynchronizationBarrier(serverUrl, authRevision, new OfficeSessionUnavailableError(message, 0, false));
}

export const REMOTE_PROXY_CONFIGURATION_MESSAGE = "Office Serverのtrusted HTTPS proxyまたは転送ヘッダー設定を修正してから再接続してください。端末の再認証は不要です。";
export class OfficeHttpError extends Error {
  constructor(readonly status: number) {
    super(`Office Server returned HTTP ${status}.`);
    this.name = "OfficeHttpError";
  }
}

// A cold Hermes snapshot can legitimately take several seconds while its
// profile/session indexes initialize. Keep the UI responsive, but do not
// drop into demo fallback during a normal first launch.
const FETCH_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 3_000;
const RECONNECT_MAX_DELAY_MS = 8_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_PREOPEN_WEBSOCKET_FAILURES = 3;
type OfficeClientSession = { csrfToken: string; authRevision: number; desktopCapability?: string };
export type OfficeWebSocketLease = { socket: WebSocket; authRevision: number };
const officeSessions = new Map<string, Promise<OfficeClientSession>>();
const officeSessionRefreshes = new Map<string, Promise<OfficeClientSession>>();
const officeSessionRecoveryPending = new Set<string>();
const officeAuthChangeObservers = new Set<(serverUrl: string) => void>();
const officeSessionRecoveryObservers = new Set<(serverUrl: string, authRevision: number) => void>();
let authRequiredObserver: ((serverUrl: string) => void) | undefined;
let nextOfficeConnectionGeneration = 0;
let nextOfficeAuthRevision = 0;
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

export function subscribeOfficeAuthChanges(observer: (serverUrl: string) => void): () => void {
  officeAuthChangeObservers.add(observer);
  return () => officeAuthChangeObservers.delete(observer);
}

/**
 * Opens a WebSocket only after this tab has a current Office session. Remote
 * device credentials remain in the HttpOnly cookie; the returned revision is
 * an in-memory generation used solely to coalesce expiry recovery.
 */
export async function openOfficeWebSocket(url: string, serverUrl: string, signal?: AbortSignal): Promise<OfficeWebSocketLease> {
  assertOfficeWebSocketTarget(url, serverUrl);
  try {
    const session = await ensureOfficeSession(serverUrl);
    if (new URL(url).pathname === "/api/v1/chat") await waitForOfficeSynchronization(serverUrl, session.authRevision, signal);
    if (signal?.aborted) throw new DOMException("Chat recovery was cancelled.", "AbortError");
    return {
      socket: await createAuthenticatedOfficeWebSocket(url),
      authRevision: session.authRevision,
    };
  } catch (error) {
    if (error instanceof OfficeDeviceAuthRequiredError) publishAuthRequired(serverUrl);
    throw error;
  }
}

function assertOfficeWebSocketTarget(value: string, serverUrl: string): void {
  const socketUrl = new URL(value);
  const server = new URL(serverUrl);
  const expectedProtocol = server.protocol === "https:" ? "wss:" : "ws:";
  if (!["http:", "https:"].includes(server.protocol)
    || socketUrl.protocol !== expectedProtocol
    || socketUrl.host !== server.host
    || !["/api/v1/events", "/api/v1/chat"].includes(socketUrl.pathname)
    || socketUrl.username !== "" || socketUrl.password !== ""
    || socketUrl.search !== "" || socketUrl.hash !== "") {
    throw new Error("Office WebSocket target is invalid.");
  }
}

/**
 * Recovers a rejected WebSocket lease through the same Origin-checked device
 * renewal endpoint used by HTTP requests. Event and chat transports share the
 * module-level single-flight refresh and therefore cannot stampede renewal.
 */
export async function recoverOfficeWebSocketAuthentication(serverUrl: string, rejectedAuthRevision: number): Promise<void> {
  try {
    await recoverOfficeSession(serverUrl, rejectedAuthRevision);
  } catch (error) {
    if (error instanceof OfficeDeviceAuthRequiredError) {
      publishAuthRequired(serverUrl);
      throw error;
    }
    if (error instanceof OfficeSessionUnavailableError) throw error;
    throw new OfficeSessionUnavailableError(errorMessage(error));
  }
}

export function connectOfficeApi(callbacks: OfficeApiCallbacks, configuredServerUrl = officeServerUrl()): OfficeApiConnection {
  const serverUrl = configuredServerUrl.replace(/\/$/, "");
  authRequiredObserver = callbacks.onAuthRequired;
  let stopped = false;
  let connectionGeneration = 0;
  let latestSnapshotRequestGeneration = 0;
  const snapshotRequestsAwaitingSession = new Set<number>();
  let socket: WebSocket | undefined;
  let eventStreamOpening = false;
  let eventStreamAttempt: symbol | undefined;
  let eventStreamAbort: AbortController | undefined;
  let reconnectTimer: number | undefined;
  let refreshTimer: number | undefined;
  let reconnectAttempt = 0;
  let socketAuthRevision: number | undefined;
  let socketOpened = false;
  let socketFailedBeforeOpen = false;
  let attemptedRecoveryRevision: number | undefined;
  let preOpenFailureCount = 0;
  let recoverySynchronizationGeneration: number | undefined;
  let recoverySynchronizationRevision: number | undefined;
  let rearmEventsAfterRecovery = false;
  let recoveryEventOpenRevision: number | undefined;
  let recoveryEventOpenGeneration: number | undefined;
  let reportedEventStreamState: "closed" | "connecting" | "open" | undefined;
  const reportRecoveryUnavailable = (message: string) => (callbacks.onRecoveryUnavailable ?? callbacks.onError)(message, serverUrl);
  const reportEventStream = (state: "closed" | "connecting" | "open") => {
    if (reportedEventStreamState === state) return;
    reportedEventStreamState = state;
    callbacks.onEventStream(state);
  };

  const scheduleEventReconnect = (minimumDelayMs = 0): boolean => {
    if (stopped || reconnectTimer !== undefined) return true;
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return false;
    const delay = Math.max(minimumDelayMs, Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_DELAY_MS * (2 ** reconnectAttempt)));
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      void openEvents();
    }, delay);
    return true;
  };

  const stopSocket = () => {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    reconnectTimer = undefined;
    refreshTimer = undefined;
    const closingSocket = socket;
    socket = undefined;
    eventStreamAbort?.abort();
    eventStreamAbort = undefined;
    eventStreamOpening = false;
    eventStreamAttempt = undefined;
    socketAuthRevision = undefined;
    socketOpened = false;
    socketFailedBeforeOpen = false;
    closingSocket?.close(1000, "Client stopped");
    reportEventStream("closed");
  };

  const isCurrentSnapshotRequest = (identity: OfficeSnapshotRequestIdentity) => !stopped
    && identity.serverUrl === serverUrl
    && identity.connectionGeneration === connectionGeneration
    && identity.requestGeneration === latestSnapshotRequestGeneration;

  const loadSnapshot = async (showConnecting: boolean, expectedConnectionGeneration: number, preserveRuntime = false): Promise<OfficeSnapshotRequestIdentity | undefined> => {
    if (stopped || expectedConnectionGeneration !== connectionGeneration) return undefined;
    const identity: OfficeSnapshotRequestIdentity = {
      serverUrl,
      connectionGeneration: expectedConnectionGeneration,
      requestGeneration: ++latestSnapshotRequestGeneration
    };
    if (showConnecting) callbacks.onConnecting(serverUrl);
    try {
      snapshotRequestsAwaitingSession.add(identity.requestGeneration);
      try { await ensureOfficeSession(serverUrl); } finally { snapshotRequestsAwaitingSession.delete(identity.requestGeneration); }
      const health = await officeFetchJson<HealthResponse>("/api/v1/health", {}, serverUrl);
      if (!isHealthResponse(health)) throw new Error("Office Server health response is incompatible.");
      const snapshot = await officeFetchJson<OfficeSnapshot>("/api/v1/snapshot", {}, serverUrl);
      if (!isOfficeSnapshot(snapshot)) throw new Error("Office Server snapshot is incompatible.");
      if (snapshot.capabilities.protocolVersion !== health.protocolVersion) {
        throw new Error("Office Server protocol versions do not match.");
      }
      if (!isCurrentSnapshotRequest(identity)) return undefined;
      callbacks.onSnapshot(snapshot, identity);
      if (recoverySynchronizationGeneration === identity.connectionGeneration) {
        const synchronizedRevision = recoverySynchronizationRevision;
        const shouldRearmEvents = rearmEventsAfterRecovery;
        recoverySynchronizationGeneration = undefined;
        rearmEventsAfterRecovery = false;
        if (shouldRearmEvents && synchronizedRevision !== undefined) {
          recoveryEventOpenRevision = synchronizedRevision;
          recoveryEventOpenGeneration = identity.connectionGeneration;
          void openEvents();
        }
      }
      return identity;
    } catch (error) {
      if (!isCurrentSnapshotRequest(identity)) return undefined;
      const recoverySnapshotFailed = recoverySynchronizationGeneration === identity.connectionGeneration;
      if (recoverySnapshotFailed) {
        recoverySynchronizationGeneration = undefined;
        if (rearmEventsAfterRecovery) reportEventStream("closed");
        rearmEventsAfterRecovery = false;
        if (recoverySynchronizationRevision !== undefined) rejectOfficeSynchronization(serverUrl, recoverySynchronizationRevision, errorMessage(error));
      }
      if (error instanceof OfficeDeviceAuthRequiredError) {
        callbacks.onAuthRequired?.(serverUrl);
        return undefined;
      }
      const report = preserveRuntime || recoverySnapshotFailed ? callbacks.onRecoveryUnavailable ?? callbacks.onError : callbacks.onError;
      report(errorMessage(error), serverUrl);
      return undefined;
    }
  };

  const refreshAfterSessionRecovery = (recoveredServerUrl: string, authRevision: number) => {
    if (stopped || recoveredServerUrl !== serverUrl) return;
    const expectedConnectionGeneration = connectionGeneration;
    recoverySynchronizationGeneration = expectedConnectionGeneration;
    recoverySynchronizationRevision = authRevision;
    rearmEventsAfterRecovery = true;
    stopSocket();
    reportEventStream("connecting");
    if (snapshotRequestsAwaitingSession.has(latestSnapshotRequestGeneration)) return;
    void loadSnapshot(false, expectedConnectionGeneration, true);
  };
  officeSessionRecoveryObservers.add(refreshAfterSessionRecovery);
  let unsubscribeSynchronizationRequests = subscribeOfficeSynchronizationRequests(refreshAfterSessionRecovery);

  const scheduleSnapshotRefresh = () => {
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    const expectedConnectionGeneration = connectionGeneration;
    refreshTimer = window.setTimeout(() => void loadSnapshot(false, expectedConnectionGeneration), 120);
  };

  const openEvents = async () => {
    if (stopped || socket || eventStreamOpening) return;
    const attempt = Symbol("event-stream-open");
    const abort = new AbortController();
    eventStreamOpening = true;
    eventStreamAttempt = attempt;
    eventStreamAbort = abort;
    reportEventStream("connecting");
    let lease: OfficeWebSocketLease;
    try {
      lease = await openOfficeWebSocket(toWebSocketUrl(serverUrl), serverUrl, abort.signal);
    } catch (error) {
      if (eventStreamAttempt !== attempt) return;
      eventStreamOpening = false;
      eventStreamAttempt = undefined;
      eventStreamAbort = undefined;
      reportEventStream("closed");
      if (recoveryEventOpenRevision !== undefined) {
        rejectOfficeSynchronization(serverUrl, recoveryEventOpenRevision, errorMessage(error));
        recoveryEventOpenRevision = undefined;
        recoveryEventOpenGeneration = undefined;
        reportRecoveryUnavailable(errorMessage(error));
        return;
      }
      if (error instanceof OfficeDeviceAuthRequiredError) callbacks.onAuthRequired?.(serverUrl);
      else {
        reportRecoveryUnavailable(errorMessage(error));
        if (error instanceof OfficeSessionUnavailableError && !error.retryAutomatically) return;
        const retryAfterMs = error instanceof OfficeSessionUnavailableError ? error.retryAfterMs : 0;
        if (!scheduleEventReconnect(retryAfterMs)) reportRecoveryUnavailable("Office Serverへ再接続できませんでした。手動で再試行してください。");
      }
      return;
    }
    if (eventStreamAttempt !== attempt) { lease.socket.close(1000, "Superseded connection"); return; }
    eventStreamOpening = false;
    eventStreamAttempt = undefined;
    eventStreamAbort = undefined;
    const nextSocket = lease.socket;
    if (stopped || socket) { nextSocket.close(1000, "Client stopped"); return; }
    socket = nextSocket;
    socketAuthRevision = lease.authRevision;
    socketOpened = false;
    socketFailedBeforeOpen = false;
    socket.addEventListener("open", () => {
      if (socket !== nextSocket || stopped) return;
      socketOpened = true;
      preOpenFailureCount = 0;
      reconnectAttempt = 0;
      attemptedRecoveryRevision = undefined;
      reportEventStream("open");
      if (recoveryEventOpenRevision !== undefined && recoveryEventOpenGeneration === connectionGeneration) {
        const synchronizedRevision = recoveryEventOpenRevision;
        recoveryEventOpenRevision = undefined;
        recoveryEventOpenGeneration = undefined;
        recoverySynchronizationRevision = undefined;
        resolveOfficeSynchronization(serverUrl, synchronizedRevision);
      }
    });
    socket.addEventListener("message", (event) => {
      const message = parseEvent(event.data);
      if (!message) return;
      callbacks.onEvent?.(message);
      if (message.topic === "resync.required" || message.topic.endsWith(".changed") || message.topic === "runtime.status") {
        scheduleSnapshotRefresh();
      }
    });
    socket.addEventListener("close", (event) => {
      if (socket !== nextSocket) return;
      const rejectedRevision = socketAuthRevision;
      const ambiguousPreOpenFailure = !socketOpened && (event.code === 1006 || socketFailedBeforeOpen);
      if (ambiguousPreOpenFailure) preOpenFailureCount += 1;
      const needsAuthentication = shouldRecoverOfficeWebSocket(event, socketOpened, socketFailedBeforeOpen)
        && (!ambiguousPreOpenFailure || preOpenFailureCount === 1);
      socket = undefined;
      socketAuthRevision = undefined;
      socketOpened = false;
      socketFailedBeforeOpen = false;
      reportEventStream("closed");
      if (stopped) return;
      if (!socketOpened && recoveryEventOpenRevision !== undefined) {
        rejectOfficeSynchronization(serverUrl, recoveryEventOpenRevision, "Office event stream did not open.");
        recoveryEventOpenRevision = undefined;
        recoveryEventOpenGeneration = undefined;
        reportRecoveryUnavailable("Office event stream did not open.");
        return;
      }
      if (ambiguousPreOpenFailure && preOpenFailureCount >= MAX_PREOPEN_WEBSOCKET_FAILURES) {
        reportRecoveryUnavailable("Office WebSocketへ接続できませんでした。再接続をお試しください。");
        return;
      }
      if (!needsAuthentication || rejectedRevision === undefined) {
        if (!scheduleEventReconnect()) reportRecoveryUnavailable("Office WebSocketへ再接続できませんでした。手動で再試行してください。");
        return;
      }
      if (attemptedRecoveryRevision === rejectedRevision) {
        callbacks.onAuthRequired?.(serverUrl);
        return;
      }
      attemptedRecoveryRevision = rejectedRevision;
      const recoveryConnectionGeneration = connectionGeneration;
      void recoverOfficeWebSocketAuthentication(serverUrl, rejectedRevision).then(
        () => {
          if (!stopped && connectionGeneration === recoveryConnectionGeneration
            && recoverySynchronizationGeneration !== recoveryConnectionGeneration
            && !scheduleEventReconnect()) {
            reportRecoveryUnavailable("Office WebSocketへ再接続できませんでした。手動で再試行してください。");
          }
        },
        (error) => {
          if (stopped || connectionGeneration !== recoveryConnectionGeneration || error instanceof OfficeDeviceAuthRequiredError) return;
          reportRecoveryUnavailable(errorMessage(error));
          if (error instanceof OfficeSessionUnavailableError && !error.retryAutomatically) return;
          const retryAfterMs = error instanceof OfficeSessionUnavailableError ? error.retryAfterMs : 0;
          if (!scheduleEventReconnect(retryAfterMs)) reportRecoveryUnavailable("Office Serverへ再接続できませんでした。手動で再試行してください。");
        },
      );
    });
    socket.addEventListener("error", () => {
      if (socket !== nextSocket) return;
      socketFailedBeforeOpen = !socketOpened;
      nextSocket.close();
    });
  };

  const start = async () => {
    connectionGeneration = ++nextOfficeConnectionGeneration;
    latestSnapshotRequestGeneration = 0;
    reconnectAttempt = 0;
    attemptedRecoveryRevision = undefined;
    preOpenFailureCount = 0;
    stopSocket();
    const synchronizingRecovery = recoverySynchronizationRevision !== undefined;
    if (synchronizingRecovery) {
      beginOfficeSynchronization(serverUrl, recoverySynchronizationRevision!);
      recoverySynchronizationGeneration = connectionGeneration;
      rearmEventsAfterRecovery = true;
      reportEventStream("connecting");
    }
    const identity = await loadSnapshot(true, connectionGeneration, synchronizingRecovery);
    if (identity && isCurrentSnapshotRequest(identity)) void openEvents();
  };

  void start();
  return {
    stop() {
      stopped = true;
      officeSessionRecoveryObservers.delete(refreshAfterSessionRecovery);
      unsubscribeSynchronizationRequests();
      unsubscribeSynchronizationRequests = () => {};
      connectionGeneration = ++nextOfficeConnectionGeneration;
      latestSnapshotRequestGeneration = 0;
      recoverySynchronizationGeneration = undefined;
      if (recoverySynchronizationRevision !== undefined) rejectOfficeSynchronization(serverUrl, recoverySynchronizationRevision, "Office recovery was stopped.");
      recoverySynchronizationRevision = undefined;
      rearmEventsAfterRecovery = false;
      recoveryEventOpenRevision = undefined;
      recoveryEventOpenGeneration = undefined;
      stopSocket();
    },
    retry() {
      stopped = false;
      officeSessionRecoveryObservers.add(refreshAfterSessionRecovery);
      unsubscribeSynchronizationRequests();
      unsubscribeSynchronizationRequests = subscribeOfficeSynchronizationRequests(refreshAfterSessionRecovery);
      void start();
    },
    async refresh(expected) {
      if (stopped || (expected && (expected.serverUrl !== serverUrl || expected.connectionGeneration !== connectionGeneration))) return undefined;
      return await loadSnapshot(false, connectionGeneration);
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
    if (error instanceof OfficeDeviceAuthRequiredError) publishAuthRequired(serverUrl);
    throw error;
  }
}

/**
 * Starts a one-shot device login. The credential is serialized directly into
 * the request body and is never placed in module state, signals, URLs, or logs.
 */
export async function authenticateRemoteDevice(deviceNameInput: string, credential: string, serverUrl = officeServerUrl()): Promise<DeviceLoginResult> {
  const deviceName = normalizeDeviceName(deviceNameInput);
  if (!deviceName) return { ok: false, ...classifyDeviceLoginFailure(400, null) };
  try {
    const response = await fetch(`${serverUrl}/api/v1/auth/device`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token: credential, deviceName })
    });
    if (!response.ok) return { ok: false, ...classifyDeviceLoginFailure(response.status, response.headers.get("Retry-After")) };
    const session = parseOfficeSession(await response.json() as unknown);
    if (!session) return { ok: false, ...classifyDeviceLoginFailure(500, null) };
    notifyOfficeAuthChange(serverUrl);
    officeSessionRecoveryPending.delete(serverUrl);
    officeSessions.set(serverUrl, Promise.resolve(issueOfficeClientSession(session.csrfToken)));
    return { ok: true };
  } catch {
    return { ok: false, ...classifyDeviceLoginFailure(0, null) };
  }
}


export async function fetchRemoteConfigStatus(serverUrl = officeServerUrl()): Promise<RemoteConfigStatus> {
  return await officeFetchJson<RemoteConfigStatus>("/api/v1/host/remote", {}, serverUrl);
}

export type DeviceRevokeFailureCode = "not_found" | "forbidden" | "unavailable" | "unknown";

export class DeviceRevokeError extends Error {
  constructor(readonly status: number, readonly code: DeviceRevokeFailureCode) {
    super("Device revoke failed.");
    this.name = "DeviceRevokeError";
  }
}

export async function revokeRemoteDevice(deviceId: string, serverUrl = officeServerUrl()): Promise<void> {
  try {
    await officeFetchJson<{ ok: true }>(`/api/v1/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" }, serverUrl);
  } catch (error) {
    if (error instanceof OfficeHttpError) {
      let code: DeviceRevokeFailureCode = "unknown";
      if (error.status === 404) code = "not_found";
      else if (error.status === 401 || error.status === 403) code = "forbidden";
      else if (error.status === 0 || error.status >= 500) code = "unavailable";
      throw new DeviceRevokeError(error.status, code);
    }
    throw new DeviceRevokeError(0, "unavailable");
  }
}


export async function logoutRemoteDevice(serverUrl = officeServerUrl()): Promise<void> {
  notifyOfficeAuthChange(serverUrl);
  await officeFetchJson<{ ok: true }>("/api/v1/auth/logout", { method: "POST" }, serverUrl);
  officeSessions.delete(serverUrl);
  officeSessionRefreshes.delete(serverUrl);
  officeSessionRecoveryPending.delete(serverUrl);
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
      const replacement = await recoverOfficeSession(serverUrl, session.authRevision);
      return await requestOfficeJson<T>(url, options, replacement, serverUrl, false);
    }
    if (!response.ok) throw new OfficeHttpError(response.status);
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
  void pending.then((session) => {
    if (officeSessions.get(serverUrl) === pending && officeSessionRecoveryPending.delete(serverUrl)) {
      beginOfficeSynchronization(serverUrl, session.authRevision);
      notifyOfficeSessionRecovered(serverUrl, session.authRevision);
    }
  }, () => undefined);
  return pending;
}

function refreshOfficeSession(serverUrl: string): Promise<OfficeClientSession> {
  const current = officeSessionRefreshes.get(serverUrl);
  if (current) return current;
  notifyOfficeAuthChange(serverUrl);
  officeSessionRecoveryPending.add(serverUrl);
  officeSessions.delete(serverUrl);
  const pending = ensureOfficeSession(serverUrl);
  officeSessionRefreshes.set(serverUrl, pending);
  void pending.then(
    () => { if (officeSessionRefreshes.get(serverUrl) === pending) officeSessionRefreshes.delete(serverUrl); },
    () => { if (officeSessionRefreshes.get(serverUrl) === pending) officeSessionRefreshes.delete(serverUrl); }
  );
  return pending;
}

async function recoverOfficeSession(serverUrl: string, rejectedAuthRevision: number): Promise<OfficeClientSession> {
  const current = officeSessions.get(serverUrl);
  if (current) {
    const session = await current;
    if (session.authRevision !== rejectedAuthRevision) return session;
  }
  return await refreshOfficeSession(serverUrl);
}

async function bootstrapLocalSession(serverUrl: string): Promise<OfficeClientSession> {
  const capability = await desktopCapability();
  if (capability !== undefined) return issueOfficeClientSession("desktop-capability", capability);
  let response: Response;
  try {
    response = await boundedAuthFetch(`${serverUrl}/api/v1/auth/local`, {
      method: "POST", credentials: "include", headers: { Accept: "application/json" }
    });
  } catch (error) {
    throw new OfficeSessionUnavailableError(errorMessage(error));
  }
  if (response.status === 403 && !isLocalOfficeClient(location)) {
    let renewal: Response;
    try {
      renewal = await boundedAuthFetch(`${serverUrl}/api/v1/auth/device/renew`, {
        method: "POST", credentials: "include", headers: { Accept: "application/json" }
      });
    } catch (error) {
      throw new OfficeSessionUnavailableError(errorMessage(error));
    }
    if (renewal.ok) {
      let body: unknown;
      try { body = await renewal.json() as unknown; } catch { throw new OfficeSessionUnavailableError("Office session renewal response is incompatible."); }
      const renewed = parseOfficeSession(body);
      if (renewed) return issueOfficeClientSession(renewed.csrfToken);
      throw new OfficeSessionUnavailableError("Office session renewal response is incompatible.");
    }
    if (renewal.status === 401) throw new OfficeDeviceAuthRequiredError();
    if (renewal.status === 403) throw new OfficeSessionUnavailableError(REMOTE_PROXY_CONFIGURATION_MESSAGE, 0, false);
    throw new OfficeSessionUnavailableError(
      `Office device session renewal failed with HTTP ${renewal.status}.`,
      renewal.status === 429 ? retryAfterMilliseconds(renewal.headers.get("Retry-After")) : 0,
    );
  }
  if (!response.ok) throw new OfficeSessionUnavailableError(`Office local authentication failed with HTTP ${response.status}.`, response.status === 429 ? retryAfterMilliseconds(response.headers.get("Retry-After")) : 0);
  let body: unknown;
  try { body = await response.json() as unknown; } catch { throw new OfficeSessionUnavailableError("Office local authentication response is incompatible."); }
  const session = parseOfficeSession(body);
  if (!session) throw new OfficeSessionUnavailableError("Office local authentication response is incompatible.");
  return issueOfficeClientSession(session.csrfToken);
}

function issueOfficeClientSession(csrfToken: string, desktopCapabilityValue?: string): OfficeClientSession {
  return {
    csrfToken,
    authRevision: ++nextOfficeAuthRevision,
    ...(desktopCapabilityValue === undefined ? {} : { desktopCapability: desktopCapabilityValue }),
  };
}

function notifyOfficeAuthChange(serverUrl: string): void {
  for (const observer of officeAuthChangeObservers) {
    try { observer(serverUrl); } catch { /* observers cannot interrupt authentication */ }
  }
}

function notifyOfficeSessionRecovered(serverUrl: string, authRevision: number): void {
  for (const observer of officeSessionRecoveryObservers) {
    try { observer(serverUrl, authRevision); } catch { /* recovery observers cannot interrupt a renewed session */ }
  }
}

function publishAuthRequired(serverUrl: string): void {
  try { authRequiredObserver?.(serverUrl); } catch { /* UI observers cannot restart recovery */ }
}

async function boundedAuthFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function retryAfterMilliseconds(value: string | null): number {
  if (value === null) return 0;
  if (/^\d{1,5}$/.test(value)) return Math.min(3_600_000, Number(value) * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(3_600_000, Math.max(0, date - Date.now())) : 0;
}

function parseOfficeSession(value: unknown): { csrfToken: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const csrfToken = (value as { csrfToken?: unknown }).csrfToken;
  return typeof csrfToken === "string" && csrfToken.length >= 16 && csrfToken.length <= 512
    ? { csrfToken }
    : undefined;
}

export function shouldRecoverOfficeWebSocket(event: Pick<CloseEvent, "code" | "reason">, opened: boolean, failedBeforeOpen = false): boolean {
  if (!opened && (event.code === 1006 || failedBeforeOpen)) return true;
  return event.code === 1008 && /(?:auth|credential|device|session)/i.test(event.reason);
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
    && isInventoryPagination(candidate.inventory?.profiles)
    && isInventoryPagination(candidate.inventory?.sessions)
    && typeof candidate.capabilities?.protocolVersion === "number"
    && typeof candidate.capabilities.runtime?.state === "string"
    && Array.isArray(candidate.capabilities.features)
    && candidate.capabilities.features.every((feature) => ["chat", "profiles", "skills", "memory", "kanban", "global-inheritance", "demo"].includes(feature))
    && isOfficeAccess(candidate.capabilities.access);
}

function isInventoryPagination(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return typeof page.returned === "number" && page.returned >= 0 && page.returned <= 100 && Number.isSafeInteger(page.returned)
    && typeof page.available === "number" && page.available >= page.returned && Number.isSafeInteger(page.available)
    && typeof page.hasMore === "boolean" && typeof page.truncated === "boolean"
    && typeof page.partialFailures === "number" && page.partialFailures >= 0 && Number.isSafeInteger(page.partialFailures)
    && (page.total === undefined || (typeof page.total === "number" && page.total >= page.available && Number.isSafeInteger(page.total)))
    && (page.partialFailures === 0 || page.truncated === true)
    && (!page.hasMore || (typeof page.nextCursor === "string" && page.nextCursor.length <= 256));
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
    && access.allowedOperations.every((operation) => typeof operation === "string" && Object.hasOwn(OPERATION_POLICIES, operation));
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Office Serverへの接続がタイムアウトしました。";
  if (error instanceof Error) return error.message;
  return "Office Serverへ接続できませんでした。";
}
