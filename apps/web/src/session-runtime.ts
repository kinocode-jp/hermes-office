import type { ChatSession } from "./domain";

export function mergeServerSessionStatus(previous: ChatSession | undefined, activity: string): ChatSession["status"] {
  const incoming = serverSessionStatus(activity);
  if (!previous) return incoming;
  if (previous.pendingInteraction || previous.status === "waiting") return "waiting";
  if (previous.connectionState === "error") return previous.status;
  if (incoming !== "ready") return incoming;
  return hasStreamingWork(previous) ? "streaming" : "ready";
}

export function canSubmitChatPrompt(session: ChatSession): boolean {
  const connected = session.remoteKind === "demo" || session.connectionState === "ready";
  return connected && !session.pendingInteraction && session.status === "ready" && !hasStreamingWork(session);
}

function hasStreamingWork(session: ChatSession): boolean {
  return session.status === "streaming"
    || session.streamingMessageId !== undefined
    || session.messages.some((message) => message.status === "streaming");
}

function serverSessionStatus(activity: string): ChatSession["status"] {
  if (activity === "thinking" || activity === "using-tool") return "streaming";
  if (activity === "waiting-for-user") return "waiting";
  return "ready";
}
