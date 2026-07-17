import type { ChatSession } from "./domain";
import { invalidatePendingSteer } from "./chat-run-actions";

export type ChatSessionReadyRuntime = {
  running?: boolean;
  status?: string;
};

export function reconcileChatSessionConnecting(session: ChatSession): ChatSession {
  return {
    ...terminateChatRun(session, "cancelled"),
    connectionState: "connecting",
    liveSessionId: undefined,
    readOnly: true,
    errorMessage: undefined
  };
}

export function reconcileChatSessionReady(
  session: ChatSession,
  liveSessionId: string,
  storedSessionId?: string,
  runtime?: ChatSessionReadyRuntime
): ChatSession {
  const runtimeStatus = sessionStatusFromRuntime(runtime);
  const targetChanged = session.liveSessionId !== liveSessionId;
  const reconciled = runtimeStatus === "ready" || targetChanged ? terminateChatRun(session, "cancelled") : session;
  return {
    ...reconciled,
    ...(storedSessionId ? { storedSessionId } : {}),
    ...(runtimeStatus ? { status: runtimeStatus } : {}),
    liveSessionId,
    connectionState: "ready",
    remoteKind: storedSessionId ? "stored" : session.remoteKind,
    readOnly: false,
    errorMessage: session.historyState === "error" ? session.errorMessage : undefined
  };
}

export function reconcileChatSessionDisconnected(session: ChatSession): ChatSession {
  return {
    ...terminateChatRun(session, "cancelled"),
    liveSessionId: undefined,
    connectionState: "disconnected",
    readOnly: true
  };
}

export function reconcileChatSessionError(session: ChatSession, message: string): ChatSession {
  return {
    ...terminateChatRun(session, "failed"),
    connectionState: "error",
    readOnly: true,
    errorMessage: message
  };
}

function terminateChatRun(session: ChatSession, terminalStatus: "cancelled" | "failed"): ChatSession {
  return {
    ...invalidatePendingSteer(session),
    status: "ready",
    streamingMessageId: undefined,
    pendingInteraction: undefined,
    messages: session.messages.map((message) => message.status === "streaming" ? { ...message, status: terminalStatus } : message)
  };
}

function sessionStatusFromRuntime(runtime: ChatSessionReadyRuntime | undefined): ChatSession["status"] | undefined {
  if (runtime?.running === true) return "streaming";
  if (runtime?.running === false) return "ready";
  if (typeof runtime?.status !== "string") return undefined;
  const status = runtime.status.trim().toLowerCase().replaceAll("_", "-");
  if (status === "thinking" || status === "using-tool" || status === "streaming" || status === "running") return "streaming";
  if (status === "waiting" || status === "waiting-for-user") return "waiting";
  if (status === "ready" || status === "idle") return "ready";
  return undefined;
}
