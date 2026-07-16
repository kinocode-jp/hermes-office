import type { ApprovalChoice, ChatMessage } from "./domain";
import { officeFetchJson, officeServerUrl } from "./office-api";

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
  respondApproval(clientSessionId: string, choice: ApprovalChoice): Promise<void>;
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

export function connectChatApi(callbacks: ChatApiCallbacks): ChatApiConnection {
  const serverUrl = officeServerUrl();
  const targets = new Map<string, ChatTarget>();
  const liveToClient = new Map<string, string>();
  const pending = new Map<string, PendingRequest>();
  const opening = new Set<string>();
  const historyLoads = new Set<string>();
  const loadedHistories = new Set<string>();
  let socket: WebSocket | undefined;
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
      openSocket();
    }, delay);
  };

  const handleClose = () => {
    socket = undefined;
    opening.clear();
    liveToClient.clear();
    rejectPending("Chat接続が切断されました。");
    for (const clientSessionId of targets.keys()) callbacks.onSessionDisconnected(clientSessionId);
    callbacks.onSocketState("disconnected", stopped ? undefined : "再接続を待っています");
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

  const openSocket = () => {
    if (stopped || socket) return;
    callbacks.onSocketState("connecting");
    const nextSocket = new WebSocket(chatWebSocketUrl(serverUrl));
    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket || stopped) return;
      reconnectAttempt = 0;
      callbacks.onSocketState("ready");
      for (const target of targets.values()) void openRemoteSession(target);
    });
    nextSocket.addEventListener("message", (event) => handleMessage(event.data));
    nextSocket.addEventListener("close", () => {
      if (socket === nextSocket) handleClose();
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
      const query = new URLSearchParams({ profile: target.profileId });
      const body = await officeFetchJson<unknown>(
        `/api/v1/sessions/${encodeURIComponent(target.storedSessionId)}/messages?${query.toString()}`,
        { timeoutMs: HISTORY_TIMEOUT_MS },
        serverUrl
      );
      const history = normalizeHistory(body, target.storedSessionId);
      if (history.resolvedStoredSessionId) {
        targets.set(target.clientSessionId, { ...target, storedSessionId: history.resolvedStoredSessionId });
      }
      loadedHistories.add(target.clientSessionId);
      callbacks.onHistory(target.clientSessionId, history.messages, history.resolvedStoredSessionId);
    } catch (error) {
      callbacks.onHistoryError(target.clientSessionId, errorText(error));
    } finally {
      historyLoads.delete(target.clientSessionId);
    }
  };

  openSocket();

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
    async respondApproval(clientSessionId, choice) {
      const liveSessionId = liveSessionIdFor(clientSessionId, liveToClient);
      if (!liveSessionId) throw new Error("Live Sessionが未接続です。");
      await rpc("approval.respond", { session_id: liveSessionId, choice });
    },
    retry() {
      stopped = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      rejectPending("Chat接続を再試行します。");
      socket?.close();
      socket = undefined;
      openSocket();
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

function normalizeHistory(value: unknown, storedSessionId: string): { messages: ChatMessage[]; resolvedStoredSessionId?: string } {
  const record = asRecord(value);
  const entries = Array.isArray(value) ? value : Array.isArray(record?.messages) ? record.messages : [];
  const messages = entries.flatMap((entry, index) => {
    const message = asRecord(entry);
    if (!message) return [];
    const role = typeof message.role === "string" ? message.role : typeof message.from === "string" ? message.from : "assistant";
    const body = messageText(message);
    if (!body) return [];
    return [{
      id: typeof message.id === "string" ? message.id : `history-${storedSessionId}-${index}`,
      from: role === "user" ? "user" as const : role === "tool" || role === "system" ? "tool" as const : "agent" as const,
      body,
      at: messageTime(message),
      status: "complete" as const
    }];
  });
  const resolvedStoredSessionId = typeof record?.sessionId === "string"
    ? record.sessionId
    : typeof record?.session_id === "string" ? record.session_id : undefined;
  return { messages, ...(resolvedStoredSessionId ? { resolvedStoredSessionId } : {}) };
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
