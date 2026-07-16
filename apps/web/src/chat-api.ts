import type { ApprovalChoice, ChatMessage } from "./domain";
import { officeFetchJson, officeServerUrl } from "./office-api";
import { createAuthenticatedOfficeWebSocket } from "./desktop-transport";

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
  onHistoryLoading(clientSessionId: string): void;
  onHistory(clientSessionId: string, messages: ChatMessage[], resolvedStoredSessionId?: string): void;
  onHistoryError(clientSessionId: string, message: string): void;
  onSessionConnecting(clientSessionId: string): void;
  onSessionReady(clientSessionId: string, liveSessionId: string, storedSessionId?: string): void;
  onSessionDisconnected(clientSessionId: string): void;
  onSessionError(clientSessionId: string, message: string): void;
  onEvent(clientSessionId: string, event: ChatGatewayEvent): void;
};

export type ChatApiConnection = {
  ensureSession(target: ChatTarget): void;
  releaseSession(clientSessionId: string): void;
  submitPrompt(clientSessionId: string, text: string): void;
  interrupt(clientSessionId: string): void;
  respondClarify(clientSessionId: string, requestId: string, answer: string): Promise<void>;
  respondApproval(clientSessionId: string, approvalId: string, choice: ApprovalChoice): Promise<void>;
  retry(): void;
  stop(): void;
};

type JsonRpcResult = {
  session_id?: unknown;
  stored_session_id?: unknown;
  resumed?: unknown;
  liveSessionId?: unknown;
  storedSessionId?: unknown;
  resumedSessionId?: unknown;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timeout: number;
};

const RPC_TIMEOUT_MS = 15_000;
const HISTORY_TIMEOUT_MS = 10_000;
const RECONNECT_MAX_MS = 8_000;
const HISTORY_PAGE_LIMIT = 25;
const MAX_HISTORY_PAGES = 2_000;

export function connectChatApi(callbacks: ChatApiCallbacks): ChatApiConnection {
  const serverUrl = officeServerUrl();
  const targets = new Map<string, ChatTarget>();
  const liveToClient = new Map<string, string>();
  const pending = new Map<string, PendingRequest>();
  const opening = new Set<string>();
  const historyLoads = new Set<string>();
  const loadedHistories = new Set<string>();
  let socket: WebSocket | undefined;
  let socketOpening = false;
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer: number | undefined;

  const rejectPending = (message: string) => {
    for (const request of pending.values()) {
      window.clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
    pending.clear();
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== undefined) return;
    const delay = Math.min(RECONNECT_MAX_MS, 800 * (2 ** reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      void openSocket();
    }, delay);
  };

  const handleClose = (event?: CloseEvent) => {
    const historyResyncRequired = event?.code === 1013 && event.reason.includes("reload history");
    socket = undefined;
    opening.clear();
    liveToClient.clear();
    if (historyResyncRequired) loadedHistories.clear();
    rejectPending("Chat接続が切断されました。");
    for (const clientSessionId of targets.keys()) callbacks.onSessionDisconnected(clientSessionId);
    callbacks.onSocketState(
      "disconnected",
      stopped ? undefined : historyResyncRequired ? "接続復旧後に履歴を再同期します" : "再接続を待っています",
    );
    scheduleReconnect();
  };

  const handleMessage = (data: unknown) => {
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
      const clientSessionId = liveToClient.get(liveSessionId);
      if (!clientSessionId || !type) return;
      const payload = asRecord(params?.payload);
      const storedSessionId = typeof payload?.stored_session_id === "string"
        ? payload.stored_session_id
        : typeof payload?.storedSessionId === "string" ? payload.storedSessionId : undefined;
      if (storedSessionId) {
        const target = targets.get(clientSessionId);
        if (target) targets.set(clientSessionId, { ...target, storedSessionId });
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
    window.clearTimeout(request.timeout);
    pending.delete(id);
    const error = asRecord(frame.error);
    if (error) {
      request.reject(new Error(typeof error.message === "string" ? error.message : "Chat RPCに失敗しました。"));
      return;
    }
    request.resolve(frame.result);
  };

  const openSocket = async () => {
    if (stopped || socket || socketOpening) return;
    socketOpening = true;
    callbacks.onSocketState("connecting");
    let nextSocket: WebSocket;
    try {
      nextSocket = await createAuthenticatedOfficeWebSocket(chatWebSocketUrl(serverUrl));
    } catch (error) {
      socketOpening = false;
      callbacks.onSocketState("error", errorText(error));
      scheduleReconnect();
      return;
    }
    socketOpening = false;
    if (stopped || socket) { nextSocket.close(1000, "Client stopped"); return; }
    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket || stopped) return;
      reconnectAttempt = 0;
      callbacks.onSocketState("ready");
      for (const target of targets.values()) {
        void loadHistory(target);
        void openRemoteSession(target);
      }
    });
    nextSocket.addEventListener("message", (event) => handleMessage(event.data));
    nextSocket.addEventListener("close", (event) => {
      if (socket === nextSocket) handleClose(event);
    });
    nextSocket.addEventListener("error", () => {
      callbacks.onSocketState("error", "Chat WebSocketへ接続できませんでした。");
      for (const clientSessionId of targets.keys()) callbacks.onSessionError(clientSessionId, "Chat WebSocketへ接続できませんでした。");
      nextSocket.close();
    });
  };

  const rpc = (method: string, params: Record<string, string>): Promise<unknown> => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chat接続は準備中です。"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}がタイムアウトしました。`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      socket?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  };

  const openRemoteSession = async (target: ChatTarget) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || opening.has(target.clientSessionId)) return;
    const existingLiveSessionId = liveSessionIdFor(target.clientSessionId, liveToClient);
    if (existingLiveSessionId) {
      callbacks.onSessionReady(target.clientSessionId, existingLiveSessionId, target.storedSessionId);
      return;
    }
    opening.add(target.clientSessionId);
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
      const storedSessionId = typeof result?.stored_session_id === "string"
        ? result.stored_session_id
        : typeof result?.storedSessionId === "string" ? result.storedSessionId
          : typeof result?.resumed === "string" ? result.resumed
            : typeof result?.resumedSessionId === "string" ? result.resumedSessionId : target.storedSessionId;
      const updatedTarget: ChatTarget = {
        clientSessionId: target.clientSessionId,
        profileId: target.profileId,
        ...(storedSessionId ? { storedSessionId } : {})
      };
      targets.set(target.clientSessionId, updatedTarget);
      liveToClient.set(liveSessionId, target.clientSessionId);
      callbacks.onSessionReady(target.clientSessionId, liveSessionId, storedSessionId);
    } catch (error) {
      callbacks.onSessionError(target.clientSessionId, errorText(error));
    } finally {
      opening.delete(target.clientSessionId);
    }
  };

  const loadHistory = async (target: ChatTarget) => {
    if (loadedHistories.has(target.clientSessionId) || historyLoads.has(target.clientSessionId)) return;
    if (!target.storedSessionId) {
      loadedHistories.add(target.clientSessionId);
      callbacks.onHistory(target.clientSessionId, []);
      return;
    }
    historyLoads.add(target.clientSessionId);
    callbacks.onHistoryLoading(target.clientSessionId);
    try {
      const messages: ChatMessage[] = [];
      let cursor: string | undefined;
      let resolvedStoredSessionId: string | undefined;
      for (let pageNumber = 0; pageNumber < MAX_HISTORY_PAGES; pageNumber += 1) {
        const query = new URLSearchParams({ profile: target.profileId, limit: String(HISTORY_PAGE_LIMIT) });
        if (cursor !== undefined) query.set("cursor", cursor);
        const body = await officeFetchJson<unknown>(
          `/api/v1/sessions/${encodeURIComponent(target.storedSessionId)}/messages?${query.toString()}`,
          { timeoutMs: HISTORY_TIMEOUT_MS },
          serverUrl
        );
        const page = normalizeHistoryPage(body, target.storedSessionId);
        messages.push(...page.messages);
        resolvedStoredSessionId = page.resolvedStoredSessionId ?? resolvedStoredSessionId;
        if (!page.hasMore) break;
        if (page.nextCursor === undefined || page.messages.length === 0 || pageNumber === MAX_HISTORY_PAGES - 1) {
          throw new Error("保存済み履歴がOfficeの安全な読込上限を超えました。");
        }
        cursor = page.nextCursor;
      }
      if (resolvedStoredSessionId) {
        targets.set(target.clientSessionId, { ...target, storedSessionId: resolvedStoredSessionId });
      }
      loadedHistories.add(target.clientSessionId);
      callbacks.onHistory(target.clientSessionId, messages, resolvedStoredSessionId);
    } catch (error) {
      callbacks.onHistoryError(target.clientSessionId, errorText(error));
    } finally {
      historyLoads.delete(target.clientSessionId);
    }
  };

  void openSocket();

  return {
    ensureSession(target) {
      targets.set(target.clientSessionId, target);
      void loadHistory(target);
      void openRemoteSession(target);
    },
    releaseSession(clientSessionId) {
      targets.delete(clientSessionId);
      opening.delete(clientSessionId);
      const liveSessionId = liveSessionIdFor(clientSessionId, liveToClient);
      if (!liveSessionId) return;
      liveToClient.delete(liveSessionId);
      if (socket?.readyState === WebSocket.OPEN) void rpc("session.close", { session_id: liveSessionId }).catch(() => undefined);
    },
    submitPrompt(clientSessionId, text) {
      const liveSessionId = liveSessionIdFor(clientSessionId, liveToClient);
      if (!liveSessionId) {
        callbacks.onSessionError(clientSessionId, "Live Sessionが未接続です。");
        return;
      }
      void rpc("prompt.submit", { session_id: liveSessionId, text }).catch((error) => {
        callbacks.onSessionError(clientSessionId, errorText(error));
      });
    },
    interrupt(clientSessionId) {
      const liveSessionId = liveSessionIdFor(clientSessionId, liveToClient);
      if (!liveSessionId) return;
      void rpc("session.interrupt", { session_id: liveSessionId }).catch((error) => {
        callbacks.onSessionError(clientSessionId, errorText(error));
      });
    },
    async respondClarify(clientSessionId, requestId, answer) {
      const liveSessionId = liveSessionIdFor(clientSessionId, liveToClient);
      if (!liveSessionId) throw new Error("Live Sessionが未接続です。");
      await rpc("clarify.respond", { request_id: requestId, answer });
    },
    async respondApproval(clientSessionId, approvalId, choice) {
      const liveSessionId = liveSessionIdFor(clientSessionId, liveToClient);
      if (!liveSessionId) throw new Error("Live Sessionが未接続です。");
      await rpc("approval.respond", { session_id: liveSessionId, approval_id: approvalId, choice });
    },
    retry() {
      stopped = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      rejectPending("Chat接続を再試行します。");
      socket?.close();
      socket = undefined;
      void openSocket();
    },
    stop() {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      rejectPending("Chat client stopped.");
      socket?.close(1000, "Client stopped");
      socket = undefined;
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

function liveSessionIdFor(clientSessionId: string, liveToClient: Map<string, string>): string | undefined {
  return [...liveToClient.entries()].find(([, clientId]) => clientId === clientSessionId)?.[0];
}

export function normalizeHistoryPage(value: unknown, storedSessionId: string): {
  messages: ChatMessage[];
  resolvedStoredSessionId?: string;
  hasMore: boolean;
  nextCursor?: string;
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
  const nextCursor = typeof pagination?.nextCursor === "string" && pagination.nextCursor.length <= 64
    ? pagination.nextCursor
    : undefined;
  if (hasMore && nextCursor === undefined) throw new Error("Office Serverの履歴ページ情報に互換性がありません。");
  return {
    messages,
    ...(resolvedStoredSessionId ? { resolvedStoredSessionId } : {}),
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
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
  if (typeof message.at === "string") return message.at;
  const value = message.createdAt ?? message.created_at ?? message.timestamp;
  const date = typeof value === "number"
    ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
    : typeof value === "string" ? new Date(value) : new Date();
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Chat APIがタイムアウトしました。";
  return error instanceof Error ? error.message : "Chat APIに接続できませんでした。";
}
