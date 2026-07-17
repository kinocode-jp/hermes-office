import type { ApprovalChoice, ChatMessage } from "./domain";
import {
  officeFetchJson,
  officeServerUrl,
  OfficeDeviceAuthRequiredError,
  OfficeSessionUnavailableError,
  openOfficeWebSocket,
  recoverOfficeWebSocketAuthentication,
  shouldRecoverOfficeWebSocket,
  subscribeOfficeSessionSynchronizations,
  type OfficeWebSocketLease,
} from "./office-api";
import { DEFAULT_CLIENT_HISTORY_LIMITS, HistoryAccumulator, type ChatHistoryResult } from "./history-loader";

export type { ChatHistoryResult } from "./history-loader";

export type ChatTarget = {
  clientSessionId: string;
  profileId: string;
  storedSessionId?: string;
};

export type ChatGatewayEvent = {
  type: string;
  liveSessionId: string;
  payload?: Record<string, unknown>;
};

export type ChatApiCallbacks = {
  onSocketState(state: "disconnected" | "connecting" | "ready" | "error", message?: string): void;
  onHistoryLoading(clientSessionId: string, resetTranscript?: boolean): void;
  onHistory(clientSessionId: string, messages: ChatMessage[], resolvedStoredSessionId?: string, result?: ChatHistoryResult): void;
  onHistoryError(clientSessionId: string, message: string): void;
  onSessionConnecting(clientSessionId: string): void;
  onSessionReady(clientSessionId: string, liveSessionId: string, storedSessionId?: string, runtime?: ChatSessionRuntime): void;
  onSessionDisconnected(clientSessionId: string): void;
  onSessionError(clientSessionId: string, message: string): void;
  onEvent(clientSessionId: string, event: ChatGatewayEvent): void;
};

export type ChatSessionRuntime = { running?: boolean; status?: string };

export type ChatSteerResult =
  | { status: "queued" }
  | { status: "rejected" }
  | { status: "invalid" };

export type ChatPromptResult =
  | { status: "accepted" }
  | { status: "rejected"; message: string }
  | { status: "unconfirmed"; message: string };

export type ChatApiConnection = {
  ensureSession(target: ChatTarget): void;
  releaseSession(clientSessionId: string): void;
  submitPrompt(clientSessionId: string, text: string, operationId: string): Promise<ChatPromptResult>;
  steer(clientSessionId: string, text: string): Promise<ChatSteerResult>;
  interrupt(clientSessionId: string): void;
  respondClarify(clientSessionId: string, requestId: string, answer: string): Promise<void>;
  respondApproval(clientSessionId: string, approvalId: string, choice: ApprovalChoice): Promise<void>;
  retry(): void;
  stop(): void;
};

export type ChatApiDependencies = {
  serverUrl?: string;
  createWebSocket?: (url: string) => Promise<WebSocket>;
  openWebSocket?: (url: string, serverUrl: string, signal?: AbortSignal) => Promise<OfficeWebSocketLease>;
  recoverAuthentication?: (serverUrl: string, rejectedAuthRevision: number) => Promise<void>;
  reconnectDelay?: (attempt: number, minimumDelayMs: number) => number;
  fetchJson?: typeof officeFetchJson;
  randomId?: () => string;
  subscribeSessionSynchronizations?: (observer: (serverUrl: string, authRevision: number) => void) => () => void;
};

type JsonRpcResult = {
  session_id?: unknown;
  stored_session_id?: unknown;
  resumed?: unknown;
  liveSessionId?: unknown;
  storedSessionId?: unknown;
  resumedSessionId?: unknown;
  running?: unknown;
  status?: unknown;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

const RPC_REJECTED = Symbol("rpc-rejected");

type ExplicitRpcRejection = Error & { [RPC_REJECTED]: true };

function explicitRpcRejection(message: string): ExplicitRpcRejection {
  return Object.assign(new Error(message), { [RPC_REJECTED]: true as const });
}

function isExplicitRpcRejection(error: unknown): error is ExplicitRpcRejection {
  return typeof error === "object" && error !== null && RPC_REJECTED in error;
}

type ActiveTarget = { generation: number; target: ChatTarget };
type LiveTarget = { clientSessionId: string; generation: number };

const RPC_TIMEOUT_MS = 15_000;
const HISTORY_TIMEOUT_MS = 10_000;
const RECONNECT_MAX_MS = 8_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_PREOPEN_WEBSOCKET_FAILURES = 3;
const HISTORY_PAGE_LIMIT = 25;
const MAX_HISTORY_PAGES = DEFAULT_CLIENT_HISTORY_LIMITS.maxPages;

export function connectChatApi(callbacks: ChatApiCallbacks, dependencies: ChatApiDependencies = {}): ChatApiConnection {
  const serverUrl = dependencies.serverUrl ?? officeServerUrl();
  const openWebSocket = dependencies.openWebSocket ?? (dependencies.createWebSocket
    ? async (url: string) => ({ socket: await dependencies.createWebSocket!(url), authRevision: 0 })
    : openOfficeWebSocket);
  const recoverAuthentication = dependencies.recoverAuthentication ?? recoverOfficeWebSocketAuthentication;
  const reconnectDelay = dependencies.reconnectDelay ?? ((attempt: number, minimumDelayMs: number) => Math.max(minimumDelayMs, Math.min(RECONNECT_MAX_MS, 800 * (2 ** attempt))));
  const fetchJson = dependencies.fetchJson ?? officeFetchJson;
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const subscribeSessionSynchronizations = dependencies.subscribeSessionSynchronizations ?? subscribeOfficeSessionSynchronizations;
  const targets = new Map<string, ActiveTarget>();
  const liveToClient = new Map<string, LiveTarget>();
  const pending = new Map<string, PendingRequest>();
  const opening = new Map<string, symbol>();
  const historyLoads = new Map<string, symbol>();
  const loadedHistories = new Map<string, ActiveTarget>();
  const historiesAwaitingReset = new Set<string>();
  const targetStartOperations = new Map<string, symbol>();
  let nextGeneration = 0;
  let socket: WebSocket | undefined;
  let socketOpening = false;
  let socketOpenAttempt: symbol | undefined;
  let socketOpenAbort: AbortController | undefined;
  let stopped = false;
  let lifecycleGeneration = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let socketAuthRevision: number | undefined;
  let socketOpened = false;
  let socketFailedBeforeOpen = false;
  let attemptedRecoveryRevision: number | undefined;
  let preOpenFailureCount = 0;
  let transportHalted = false;
  let latestSynchronizedAuthRevision = -1;
  let unsubscribeSessionSynchronizations = () => {};

  const rejectPending = (message: string) => {
    for (const request of pending.values()) {
      globalThis.clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
    pending.clear();
  };

  const scheduleReconnect = (minimumDelayMs = 0): boolean => {
    if (stopped || reconnectTimer !== undefined) return true;
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return false;
    const delay = reconnectDelay(reconnectAttempt, minimumDelayMs);
    reconnectAttempt += 1;
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = undefined;
      void openSocket();
    }, delay);
    return true;
  };

  const haltTransport = (message: string) => {
    transportHalted = true;
    callbacks.onSocketState("error", message);
    for (const clientSessionId of targets.keys()) callbacks.onSessionError(clientSessionId, message);
  };

  const handleClose = (event: CloseEvent) => {
    const rejectedRevision = socketAuthRevision;
    const ambiguousPreOpenFailure = !socketOpened && (event.code === 1006 || socketFailedBeforeOpen);
    if (ambiguousPreOpenFailure) preOpenFailureCount += 1;
    const needsAuthentication = shouldRecoverOfficeWebSocket(event, socketOpened, socketFailedBeforeOpen)
      && (!ambiguousPreOpenFailure || preOpenFailureCount === 1);
    const historyResyncRequired = event?.code === 1013 && event.reason.includes("reload history");
    socket = undefined;
    socketAuthRevision = undefined;
    socketOpened = false;
    socketFailedBeforeOpen = false;
    opening.clear();
    historyLoads.clear();
    targetStartOperations.clear();
    liveToClient.clear();
    if (historyResyncRequired) {
      loadedHistories.clear();
      for (const clientSessionId of targets.keys()) historiesAwaitingReset.add(clientSessionId);
    }
    rejectPending("Chat接続が切断されました。");
    for (const clientSessionId of targets.keys()) callbacks.onSessionDisconnected(clientSessionId);
    callbacks.onSocketState(
      "disconnected",
      stopped ? undefined : historyResyncRequired ? "接続復旧後に履歴を再同期します" : "再接続を待っています",
    );
    if (stopped) return;
    if (ambiguousPreOpenFailure && preOpenFailureCount >= MAX_PREOPEN_WEBSOCKET_FAILURES) {
      haltTransport("Chat WebSocketへ接続できませんでした。手動で再接続してください。");
      return;
    }
    if (!needsAuthentication || rejectedRevision === undefined) {
      if (!scheduleReconnect()) haltTransport("Chat WebSocketへ再接続できませんでした。手動で再接続してください。");
      return;
    }
    if (attemptedRecoveryRevision === rejectedRevision) {
      haltTransport("端末の再認証が必要です。");
      return;
    }
    attemptedRecoveryRevision = rejectedRevision;
    const recoveryGeneration = lifecycleGeneration;
    void recoverAuthentication(serverUrl, rejectedRevision).then(
      () => {
        if (!stopped && lifecycleGeneration === recoveryGeneration && !scheduleReconnect()) {
          haltTransport("Chat Serverへ再接続できませんでした。手動で再接続してください。");
        }
      },
      (error) => {
        if (stopped || lifecycleGeneration !== recoveryGeneration) return;
        if (error instanceof OfficeDeviceAuthRequiredError) { haltTransport("端末の再認証が必要です。"); return; }
        if (error instanceof OfficeSessionUnavailableError && !error.retryAutomatically) { haltTransport(errorText(error)); return; }
        const retryAfterMs = error instanceof OfficeSessionUnavailableError ? error.retryAfterMs : 0;
        if (!scheduleReconnect(retryAfterMs)) haltTransport("Chat Serverへ再接続できませんでした。手動で再接続してください。");
      },
    );
  };

  const handleMessage = (data: unknown, sourceSocket: WebSocket) => {
    if (socket !== sourceSocket) return;
    if (typeof data !== "string") return;
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (frame.method === "event") {
      const params = asRecord(frame.params);
      const liveSessionId = typeof params?.session_id === "string"
        ? params.session_id
        : typeof params?.sessionId === "string" ? params.sessionId : "";
      const type = typeof params?.type === "string" ? params.type : "";
      const liveTarget = liveToClient.get(liveSessionId);
      const active = liveTarget === undefined ? undefined : targets.get(liveTarget.clientSessionId);
      if (!liveTarget || active?.generation !== liveTarget.generation || !type) return;
      const clientSessionId = liveTarget.clientSessionId;
      const payload = asRecord(params?.payload);
      const storedSessionId = typeof payload?.stored_session_id === "string"
        ? payload.stored_session_id
        : typeof payload?.storedSessionId === "string" ? payload.storedSessionId : undefined;
      if (storedSessionId) {
        active.target = { ...active.target, storedSessionId };
        callbacks.onSessionReady(clientSessionId, liveSessionId, storedSessionId);
      }
      callbacks.onEvent(clientSessionId, {
        type,
        liveSessionId,
        ...(payload ? { payload } : {})
      });
      return;
    }

    const id = typeof frame.id === "string" || typeof frame.id === "number" ? String(frame.id) : "";
    const request = pending.get(id);
    if (!request) return;
    globalThis.clearTimeout(request.timeout);
    pending.delete(id);
    const error = asRecord(frame.error);
    if (error) {
      const message = error.code === -32006
        ? "このセッションは別の端末で使用中です。別の端末で閉じてから再接続してください。"
        : typeof error.message === "string" ? error.message : "Chat RPCに失敗しました。";
      request.reject(explicitRpcRejection(message));
      return;
    }
    request.resolve(frame.result);
  };

  const openSocket = async () => {
    if (stopped || socket || socketOpening) return;
    const attempt = Symbol("chat-socket-open");
    const abort = new AbortController();
    socketOpening = true;
    socketOpenAttempt = attempt;
    socketOpenAbort = abort;
    callbacks.onSocketState("connecting");
    let lease: OfficeWebSocketLease;
    try {
      lease = await openWebSocket(chatWebSocketUrl(serverUrl), serverUrl, abort.signal);
    } catch (error) {
      if (socketOpenAttempt !== attempt) return;
      socketOpening = false;
      socketOpenAttempt = undefined;
      socketOpenAbort = undefined;
      if (error instanceof OfficeDeviceAuthRequiredError) haltTransport("端末の再認証が必要です。");
      else {
        callbacks.onSocketState("disconnected", errorText(error));
        if (error instanceof OfficeSessionUnavailableError && !error.retryAutomatically) { haltTransport(errorText(error)); return; }
        const retryAfterMs = error instanceof OfficeSessionUnavailableError ? error.retryAfterMs : 0;
        if (!scheduleReconnect(retryAfterMs)) haltTransport("Chat Serverへ再接続できませんでした。手動で再接続してください。");
      }
      return;
    }
    if (socketOpenAttempt !== attempt) { lease.socket.close(1000, "Superseded connection"); return; }
    socketOpening = false;
    socketOpenAttempt = undefined;
    socketOpenAbort = undefined;
    const nextSocket = lease.socket;
    if (stopped || socket) { nextSocket.close(1000, "Client stopped"); return; }
    socket = nextSocket;
    socketAuthRevision = lease.authRevision;
    socketOpened = false;
    socketFailedBeforeOpen = false;
    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket || stopped) return;
      socketOpened = true;
      transportHalted = false;
      preOpenFailureCount = 0;
      reconnectAttempt = 0;
      attemptedRecoveryRevision = undefined;
      callbacks.onSocketState("ready");
      for (const target of targets.values()) startTarget(target);
    });
    nextSocket.addEventListener("message", (event) => handleMessage(event.data, nextSocket));
    nextSocket.addEventListener("close", (event) => {
      if (socket === nextSocket) handleClose(event);
    });
    nextSocket.addEventListener("error", () => {
      if (socket !== nextSocket) return;
      socketFailedBeforeOpen = !socketOpened;
      callbacks.onSocketState("error", "Chat WebSocketへ接続できませんでした。");
      for (const clientSessionId of targets.keys()) callbacks.onSessionError(clientSessionId, "Chat WebSocketへ接続できませんでした。");
      nextSocket.close();
    });
  };

  const rpc = (method: string, params: Record<string, string>, requestId?: string): Promise<unknown> => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chat接続は準備中です。"));
    const id = requestId ?? randomId();
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}がタイムアウトしました。`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      socket?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  };

  const openRemoteSession = async (active: ActiveTarget) => {
    const target = active.target;
    const operation = Symbol("open");
    const requestSocket = socket;
    if (!requestSocket || requestSocket.readyState !== WebSocket.OPEN || !isCurrentTarget(active) || opening.has(target.clientSessionId)) return;
    const existingLiveSessionId = liveSessionIdFor(active, liveToClient);
    if (existingLiveSessionId) {
      callbacks.onSessionReady(target.clientSessionId, existingLiveSessionId, target.storedSessionId);
      return;
    }
    opening.set(target.clientSessionId, operation);
    callbacks.onSessionConnecting(target.clientSessionId);
    try {
      const raw = target.storedSessionId
        ? await rpc("session.resume", { session_id: target.storedSessionId, profile: target.profileId })
        : await rpc("session.create", { profile: target.profileId });
      const envelope = asRecord(raw);
      const result = (asRecord(envelope?.value) ?? envelope) as JsonRpcResult | undefined;
      const liveSessionId = typeof result?.session_id === "string"
        ? result.session_id
        : typeof result?.liveSessionId === "string" ? result.liveSessionId : undefined;
      if (!liveSessionId) throw new Error("HermesがLive Session IDを返しませんでした。");
      if (!isCurrentTarget(active) || socket !== requestSocket) {
        bestEffortClose(liveSessionId);
        return;
      }
      const storedSessionId = typeof result?.stored_session_id === "string"
        ? result.stored_session_id
        : typeof result?.storedSessionId === "string" ? result.storedSessionId
          : typeof result?.resumed === "string" ? result.resumed
            : typeof result?.resumedSessionId === "string" ? result.resumedSessionId : target.storedSessionId;
      active.target = {
        clientSessionId: target.clientSessionId,
        profileId: target.profileId,
        ...(storedSessionId ? { storedSessionId } : {})
      };
      liveToClient.set(liveSessionId, { clientSessionId: target.clientSessionId, generation: active.generation });
      const runtime: ChatSessionRuntime = {
        ...(typeof result?.running === "boolean" ? { running: result.running } : {}),
        ...(typeof result?.status === "string" ? { status: result.status } : {})
      };
      callbacks.onSessionReady(target.clientSessionId, liveSessionId, storedSessionId, runtime);
    } catch (error) {
      if (isCurrentTarget(active) && socket === requestSocket) callbacks.onSessionError(target.clientSessionId, errorText(error));
    } finally {
      if (opening.get(target.clientSessionId) === operation) opening.delete(target.clientSessionId);
    }
  };

  const loadHistory = async (active: ActiveTarget) => {
    const target = active.target;
    const operation = Symbol("history");
    if (!isCurrentTarget(active) || loadedHistories.get(target.clientSessionId) === active || historyLoads.has(target.clientSessionId)) return;
    const resetTranscript = historiesAwaitingReset.has(target.clientSessionId);
    if (!target.storedSessionId) {
      if (!isCurrentTarget(active)) return;
      if (resetTranscript) callbacks.onHistoryLoading(target.clientSessionId, true);
      loadedHistories.set(target.clientSessionId, active);
      callbacks.onHistory(target.clientSessionId, []);
      return;
    }
    historyLoads.set(target.clientSessionId, operation);
    callbacks.onHistoryLoading(target.clientSessionId, resetTranscript);
    const history = new HistoryAccumulator();
    let resolvedStoredSessionId: string | undefined;
    try {
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < MAX_HISTORY_PAGES; pageNumber += 1) {
        const query = new URLSearchParams({ profile: target.profileId, limit: String(HISTORY_PAGE_LIMIT) });
        if (cursor !== undefined) query.set("cursor", cursor);
        const body = await fetchJson<unknown>(
          `/api/v1/sessions/${encodeURIComponent(target.storedSessionId)}/messages?${query.toString()}`,
          { timeoutMs: HISTORY_TIMEOUT_MS },
          serverUrl
        );
        if (!isCurrentHistoryLoad(active, operation)) return;
        const page = normalizeHistoryPage(body, target.storedSessionId);
        resolvedStoredSessionId = page.resolvedStoredSessionId ?? resolvedStoredSessionId;
        const shouldContinue = history.append(page);
        if (!shouldContinue) break;
        if (page.nextCursor === undefined || page.messages.length === 0 || pageNumber === MAX_HISTORY_PAGES - 1) throw new Error("保存済み履歴の継続情報が安全上限と一致しません。");
        cursor = page.nextCursor;
      }
      if (!isCurrentHistoryLoad(active, operation)) return;
      if (resolvedStoredSessionId) active.target = { ...active.target, storedSessionId: resolvedStoredSessionId };
      loadedHistories.set(target.clientSessionId, active);
      callbacks.onHistory(target.clientSessionId, history.messages, resolvedStoredSessionId, history.result());
    } catch (error) {
      if (isCurrentHistoryLoad(active, operation) && history.messages.length > 0) {
        history.fail(errorText(error));
        if (resolvedStoredSessionId) active.target = { ...active.target, storedSessionId: resolvedStoredSessionId };
        loadedHistories.set(target.clientSessionId, active);
        callbacks.onHistory(target.clientSessionId, history.messages, resolvedStoredSessionId, history.result());
      } else if (isCurrentHistoryLoad(active, operation)) callbacks.onHistoryError(target.clientSessionId, errorText(error));
    } finally {
      if (historyLoads.get(target.clientSessionId) === operation) historyLoads.delete(target.clientSessionId);
    }
  };

  const isCurrentTarget = (active: ActiveTarget): boolean => targets.get(active.target.clientSessionId) === active;
  const isCurrentHistoryLoad = (active: ActiveTarget, operation: symbol): boolean => (
    isCurrentTarget(active) && historyLoads.get(active.target.clientSessionId) === operation
  );

  const startTarget = (active: ActiveTarget): void => {
    const clientSessionId = active.target.clientSessionId;
    if (targetStartOperations.has(clientSessionId)) return;
    const recovery = Symbol("history-before-live");
    targetStartOperations.set(clientSessionId, recovery);
    void loadHistory(active).then(() => {
      if (!isCurrentTarget(active) || targetStartOperations.get(clientSessionId) !== recovery) return;
      if (loadedHistories.get(clientSessionId) !== active) return;
      historiesAwaitingReset.delete(clientSessionId);
      void openRemoteSession(active);
    }).finally(() => {
      if (targetStartOperations.get(clientSessionId) === recovery) targetStartOperations.delete(clientSessionId);
    });
  };

  const bestEffortClose = (liveSessionId: string): void => {
    if (socket?.readyState === WebSocket.OPEN) void rpc("session.close", { session_id: liveSessionId }).catch(() => undefined);
  };

  const deactivateTarget = (active: ActiveTarget): void => {
    const clientSessionId = active.target.clientSessionId;
    if (!isCurrentTarget(active)) return;
    targets.delete(clientSessionId);
    opening.delete(clientSessionId);
    historyLoads.delete(clientSessionId);
    loadedHistories.delete(clientSessionId);
    historiesAwaitingReset.delete(clientSessionId);
    targetStartOperations.delete(clientSessionId);
    for (const [liveSessionId, mapped] of liveToClient) {
      if (mapped.clientSessionId !== clientSessionId || mapped.generation !== active.generation) continue;
      liveToClient.delete(liveSessionId);
      bestEffortClose(liveSessionId);
    }
  };

  const restartTransport = (force: boolean): void => {
    if (!force && !transportHalted) return;
    stopped = false;
    transportHalted = false;
    lifecycleGeneration += 1;
    socketOpenAbort?.abort();
    socketOpenAbort = undefined;
    socketOpenAttempt = undefined;
    socketOpening = false;
    if (reconnectTimer !== undefined) globalThis.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    reconnectAttempt = 0;
    attemptedRecoveryRevision = undefined;
    preOpenFailureCount = 0;
    rejectPending("Chat接続を再試行します。");
    opening.clear();
    liveToClient.clear();
    const closingSocket = socket;
    socket = undefined;
    socketAuthRevision = undefined;
    socketOpened = false;
    socketFailedBeforeOpen = false;
    closingSocket?.close();
    void openSocket();
  };

  unsubscribeSessionSynchronizations = subscribeSessionSynchronizations((recoveredServerUrl, authRevision) => {
    if (stopped || recoveredServerUrl !== serverUrl || authRevision <= latestSynchronizedAuthRevision) return;
    latestSynchronizedAuthRevision = authRevision;
    if (!transportHalted || targets.size === 0
      || (attemptedRecoveryRevision !== undefined && authRevision <= attemptedRecoveryRevision)) return;
    restartTransport(false);
  });

  void openSocket();

  return {
    ensureSession(target) {
      const existing = targets.get(target.clientSessionId);
      if (existing !== undefined && targetsMatch(existing.target, target)) {
        restartTransport(false);
        startTarget(existing);
        return;
      }
      if (existing !== undefined) deactivateTarget(existing);
      const active: ActiveTarget = { generation: ++nextGeneration, target: { ...target } };
      targets.set(target.clientSessionId, active);
      restartTransport(false);
      startTarget(active);
    },
    releaseSession(clientSessionId) {
      const active = targets.get(clientSessionId);
      if (active !== undefined) deactivateTarget(active);
    },
    async submitPrompt(clientSessionId, text, operationId) {
      const active = targets.get(clientSessionId);
      const requestSocket = socket;
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!active || !liveSessionId || !requestSocket || requestSocket.readyState !== WebSocket.OPEN) {
        return { status: "rejected", message: "Live Sessionが未接続です。" };
      }
      try {
        await rpc("prompt.submit", { session_id: liveSessionId, text }, operationId);
        return { status: "accepted" };
      } catch (error) {
        const message = errorText(error);
        return isExplicitRpcRejection(error)
          ? { status: "rejected", message }
          : { status: "unconfirmed", message };
      }
    },
    async steer(clientSessionId, text) {
      const trimmed = text.trim();
      if (!trimmed) throw new Error("追加指示を入力してください。");
      const active = targets.get(clientSessionId);
      const requestSocket = socket;
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!active || !liveSessionId || !requestSocket || requestSocket.readyState !== WebSocket.OPEN) {
        throw new Error("Live Sessionが未接続です。");
      }
      const raw = await rpc("session.steer", { session_id: liveSessionId, text: trimmed });
      if (!isCurrentTarget(active) || socket !== requestSocket || liveSessionIdFor(active, liveToClient) !== liveSessionId) {
        throw new Error("追加指示の送信先が変更されました。現在のセッションで再試行してください。");
      }
      return normalizeSteerResult(raw);
    },
    interrupt(clientSessionId) {
      const active = targets.get(clientSessionId);
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!liveSessionId) return;
      void rpc("session.interrupt", { session_id: liveSessionId }).catch((error) => {
        callbacks.onSessionError(clientSessionId, errorText(error));
      });
    },
    async respondClarify(clientSessionId, requestId, answer) {
      const active = targets.get(clientSessionId);
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!liveSessionId) throw new Error("Live Sessionが未接続です。");
      await rpc("clarify.respond", { request_id: requestId, answer });
    },
    async respondApproval(clientSessionId, approvalId, choice) {
      const active = targets.get(clientSessionId);
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!liveSessionId) throw new Error("Live Sessionが未接続です。");
      await rpc("approval.respond", { session_id: liveSessionId, approval_id: approvalId, choice });
    },
    retry() {
      restartTransport(true);
    },
    stop() {
      stopped = true;
      unsubscribeSessionSynchronizations();
      unsubscribeSessionSynchronizations = () => {};
      lifecycleGeneration += 1;
      socketOpenAbort?.abort();
      socketOpenAbort = undefined;
      socketOpenAttempt = undefined;
      socketOpening = false;
      if (reconnectTimer !== undefined) globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      for (const active of [...targets.values()]) deactivateTarget(active);
      rejectPending("Chat client stopped.");
      const closingSocket = socket;
      socket = undefined;
      socketAuthRevision = undefined;
      socketOpened = false;
      socketFailedBeforeOpen = false;
      closingSocket?.close(1000, "Client stopped");
      callbacks.onSocketState("disconnected");
    }
  };
}

function chatWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/chat";
  url.search = "";
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function liveSessionIdFor(active: ActiveTarget, liveToClient: Map<string, LiveTarget>): string | undefined {
  return [...liveToClient.entries()].find(([, target]) => (
    target.clientSessionId === active.target.clientSessionId && target.generation === active.generation
  ))?.[0];
}

function targetsMatch(current: ChatTarget, incoming: ChatTarget): boolean {
  return current.clientSessionId === incoming.clientSessionId
    && current.profileId === incoming.profileId
    && (incoming.storedSessionId === undefined || current.storedSessionId === incoming.storedSessionId);
}

export function normalizeSteerResult(value: unknown): ChatSteerResult {
  const outer = asRecord(value);
  const result = asRecord(outer?.value) ?? outer;
  if (result?.status === "queued") return { status: "queued" };
  if (result?.status === "rejected") return { status: "rejected" };
  return { status: "invalid" };
}

export function normalizeHistoryPage(value: unknown, storedSessionId: string): {
  messages: ChatMessage[];
  direction: "older";
  resolvedStoredSessionId?: string;
  hasMore: boolean;
  nextCursor?: string;
  truncated: boolean;
  partial: boolean;
  truncationReason?: string;
} {
  const record = asRecord(value);
  const entries = Array.isArray(value) ? value : Array.isArray(record?.messages) ? record.messages : [];
  const messages = entries.flatMap((entry, index) => {
    const message = asRecord(entry);
    if (!message) return [];
    const role = typeof message.role === "string" ? message.role : typeof message.from === "string" ? message.from : "assistant";
    const body = messageText(message);
    if (!body) return [];
    return [{
      id: typeof message.id === "string"
        ? message.id
        : `history-${storedSessionId}-${typeof message.index === "number" && Number.isSafeInteger(message.index) ? message.index : index}`,
      from: role === "user" ? "user" as const : role === "tool" || role === "system" ? "tool" as const : "agent" as const,
      body,
      at: messageTime(message),
      status: "complete" as const
    }];
  });
  const resolvedStoredSessionId = typeof record?.sessionId === "string"
    ? record.sessionId
    : typeof record?.session_id === "string" ? record.session_id : undefined;
  const pagination = asRecord(record?.pagination);
  const hasMore = pagination?.hasMore === true;
  const truncated = pagination?.truncated === true;
  const nextCursor = typeof pagination?.nextCursor === "string" && pagination.nextCursor.length <= 512
    ? pagination.nextCursor
    : undefined;
  const direction = pagination?.direction;
  if ((hasMore && nextCursor === undefined) || (hasMore && truncated) || direction !== "older") throw new Error("Office Serverの履歴ページ情報に互換性がありません。");
  const truncationReason = typeof pagination?.truncationReason === "string" ? pagination.truncationReason : undefined;
  return {
    messages,
    direction: "older",
    ...(resolvedStoredSessionId ? { resolvedStoredSessionId } : {}),
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    truncated,
    partial: pagination?.partial === true,
    ...(truncationReason ? { truncationReason } : {}),
  };
}

function messageText(message: Record<string, unknown>): string {
  for (const key of ["content", "text", "body"]) {
    const value = message[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const text = value.map((part) => {
        if (typeof part === "string") return part;
        const record = asRecord(part);
        return typeof record?.text === "string" ? record.text : "";
      }).join("");
      if (text) return text;
    }
  }
  return "";
}

function messageTime(message: Record<string, unknown>): string {
  if (typeof message.at === "string") {
    if (isLegacyClockTime(message.at)) return message.at;
    const explicit = new Date(message.at);
    return Number.isNaN(explicit.valueOf()) ? message.at : explicit.toISOString();
  }
  const value = message.createdAt ?? message.created_at ?? message.timestamp;
  const date = typeof value === "number"
    ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
    : typeof value === "string" ? new Date(value) : new Date();
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}

function isLegacyClockTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
}

function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Chat APIがタイムアウトしました。";
  return error instanceof Error ? error.message : "Chat APIに接続できませんでした。";
}
