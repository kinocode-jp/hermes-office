import type { Signal } from "@preact/signals";
import type { ChatSession } from "./domain";
import { canSteerChatSession, isChatRunActive } from "./session-runtime";
import { nowTime } from "./chat-store-utils";

type SessionState = Signal<ChatSession[]>;

export function invalidatePendingSteer(session: ChatSession): ChatSession {
  if (session.steerPending !== true && session.steerOperationId === undefined) return session;
  return { ...session, steerPending: false, steerOperationId: undefined };
}

export async function steerChatRun(
  state: SessionState,
  sendSteer: (sessionId: string, text: string) => Promise<void>,
  sessionId: string,
  body: string,
): Promise<boolean> {
  const trimmed = body.trim();
  const session = state.value.find((item) => item.id === sessionId);
  if (!trimmed || !session || !canSteerChatSession(session)) return false;
  const operationId = crypto.randomUUID();
  updateSession(state, sessionId, (item) => ({ ...item, steerPending: true, steerOperationId: operationId, errorMessage: undefined }));
  try {
    await sendSteer(sessionId, trimmed);
    updateSession(state, sessionId, (item) => item.steerOperationId === operationId ? {
      ...item,
      steerPending: false,
      steerOperationId: undefined,
      messages: [...item.messages, { id: operationId, from: "user", kind: "steer", body: trimmed, at: nowTime() }],
    } : item);
    return state.value.some((item) => item.id === sessionId && item.messages.some(({ id }) => id === operationId));
  } catch {
    updateSession(state, sessionId, (item) => item.steerOperationId === operationId ? {
      ...item,
      steerPending: false,
      steerOperationId: undefined,
      errorMessage: "追加指示を送信できませんでした。接続を確認して再試行してください。",
    } : item);
    return false;
  }
}

export function interruptChatRun(
  state: SessionState,
  sendInterrupt: (sessionId: string) => void,
  sessionId: string,
): void {
  const session = state.value.find((item) => item.id === sessionId);
  if (!session || session.connectionState !== "ready" || !isChatRunActive(session)) return;
  sendInterrupt(sessionId);
  updateSession(state, sessionId, (item) => ({
    ...item,
    status: "ready",
    streamingMessageId: undefined,
    pendingInteraction: undefined,
    steerPending: false,
    steerOperationId: undefined,
    messages: item.messages.map((message) => message.status === "streaming" ? { ...message, status: "cancelled" } : message),
  }));
}

function updateSession(state: SessionState, sessionId: string, update: (session: ChatSession) => ChatSession): void {
  state.value = state.value.map((session) => session.id === sessionId ? update(session) : session);
}
