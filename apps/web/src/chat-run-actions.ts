import type { Signal } from "@preact/signals";
import type { ChatMessage, ChatSession } from "./domain";
import type { ChatSteerResult } from "./chat-api";
import { canSteerChatSession, isChatRunActive } from "./session-runtime";
import { nowTime } from "./chat-store-utils";
import { officeMessage } from "./i18n";

type SessionState = Signal<ChatSession[]>;

export const MAX_STEER_EVIDENCE_COUNT = 64;
// Larger than Hermes' maximum accepted steer body so one acknowledged
// operation is never immediately evicted solely because of its own payload.
export const MAX_STEER_EVIDENCE_BYTES = 256 * 1024;

export function boundedSteerEvidence(messages: readonly ChatMessage[]): ChatMessage[] {
  const evidence = messages.filter((message) => message.kind === "steer").slice(-MAX_STEER_EVIDENCE_COUNT);
  let bytes = evidence.reduce((total, message) => total + steerEvidenceBytes(message), 0);
  while (evidence.length > 0 && bytes > MAX_STEER_EVIDENCE_BYTES) {
    bytes -= steerEvidenceBytes(evidence.shift()!);
  }
  return evidence;
}

export function retainBoundedSteerEvidence(messages: readonly ChatMessage[]): ChatMessage[] {
  const retained = new Set(boundedSteerEvidence(messages));
  return messages.filter((message) => message.kind !== "steer" || retained.has(message));
}

export function invalidatePendingSteer(session: ChatSession): ChatSession {
  if (session.steerPending !== true && session.steerOperationId === undefined) return session;
  return { ...session, steerPending: false, steerOperationId: undefined };
}

export async function steerChatRun(
  state: SessionState,
  sendSteer: (sessionId: string, text: string) => Promise<ChatSteerResult>,
  sessionId: string,
  body: string,
): Promise<boolean> {
  const trimmed = body.trim();
  const session = state.value.find((item) => item.id === sessionId);
  if (!trimmed || !session || !canSteerChatSession(session)) return false;
  const operationId = crypto.randomUUID();
  updateSession(state, sessionId, (item) => ({ ...item, steerPending: true, steerOperationId: operationId, errorMessage: undefined }));
  try {
    const result = await sendSteer(sessionId, trimmed);
    if (result.status !== "queued") {
      updateSession(state, sessionId, (item) => item.steerOperationId === operationId ? {
        ...item,
        steerPending: false,
        steerOperationId: undefined,
        errorMessage: result.status === "rejected"
          ? officeMessage("runtime.chat.steerRejected")
          : officeMessage("runtime.chat.steerInvalidAck"),
      } : item);
      return false;
    }
    updateSession(state, sessionId, (item) => item.steerOperationId === operationId ? {
      ...item,
      steerPending: false,
      steerOperationId: undefined,
      messages: retainBoundedSteerEvidence([...item.messages, { id: operationId, from: "user", kind: "steer", body: trimmed, at: nowTime() }]),
    } : item);
    return state.value.some((item) => item.id === sessionId && item.messages.some(({ id }) => id === operationId));
  } catch {
    updateSession(state, sessionId, (item) => item.steerOperationId === operationId ? {
      ...item,
      steerPending: false,
      steerOperationId: undefined,
      errorMessage: officeMessage("runtime.chat.steerSendFailed"),
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

function steerEvidenceBytes(message: ChatMessage): number {
  return new TextEncoder().encode(`${message.id}\0${message.body}\0${message.at}`).byteLength;
}
