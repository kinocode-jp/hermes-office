import type { ChatGatewayEvent } from "./chat-api";
import type { ChatPendingInteraction, ChatSession } from "./domain";
import { isChatRunActive, mergeGatewayStatusUpdate } from "./session-runtime";
import { approvalChoices, gatewayMessageId, nowTimestamp, stringArray, stringValue } from "./chat-store-utils";
import { appendLiveDelta, appendLiveMessage, replaceLiveMessages, type TranscriptChange } from "./live-transcript";
import { officeMessage, upstreamMessage, locale } from "./i18n";
import { buildFollowUpSuggestions } from "./chat-suggestions";
import { officeSnapshot } from "./store-state";

export function reduceChatGatewayEvent(
  session: ChatSession,
  event: ChatGatewayEvent,
  onTranscriptLimit?: (reason: Extract<TranscriptChange, { status: "resync-required" }>["reason"]) => void,
): ChatSession {
  if (session.liveSessionId && event.liveSessionId !== session.liveSessionId) return session;
  const payload = event.payload ?? {};
  if (event.type === "clarify.request") {
    const requestId = stringValue(payload.requestId) ?? stringValue(payload.request_id);
    const question = stringValue(payload.question);
    if (!requestId || !question) return session;
    return withPendingInteraction(session, {
      id: `clarify:${requestId}`,
      kind: "clarify",
      requestId,
      question,
      choices: stringArray(payload.choices),
      submitting: false
    });
  }
  if (event.type === "approval.request") {
    const approvalId = stringValue(payload.approvalId) ?? stringValue(payload.approval_id);
    const command = stringValue(payload.command);
    const description = stringValue(payload.description);
    const allowPermanent = (payload.allowPermanent === true || payload.allow_permanent === true)
      && officeSnapshot.value?.capabilities.access.allowedOperations.includes("chat.approval.permanent") === true;
    const choices = approvalChoices(payload.choices, allowPermanent);
    if (!approvalId || choices.length === 0) return session;
    return withPendingInteraction(session, {
      id: `approval:${approvalId}`,
      kind: "approval",
      approvalId,
      ...(command ? { command } : {}),
      ...(description ? { description } : {}),
      choices,
      allowPermanent,
      submitting: false
    });
  }
  if (event.type === "message.start") {
    const messageId = gatewayMessageId(payload) ?? `stream-${event.liveSessionId}-${Date.now()}`;
    const change = appendLiveMessage(session.messages, { id: messageId, from: "agent", body: "", at: nowTimestamp(), status: "streaming" });
    return withTranscriptChange(session, change, onTranscriptLimit, {
      ...session,
      status: "streaming",
      streamingMessageId: messageId,
    });
  }
  if (event.type === "message.delta") {
    const delta = stringValue(payload.text) ?? stringValue(payload.delta) ?? "";
    if (!delta) return session;
    const messageId = gatewayMessageId(payload) ?? session.streamingMessageId ?? `stream-${event.liveSessionId}`;
    const exists = session.messages.some((message) => message.id === messageId);
    const change = exists
      ? appendLiveDelta(session.messages, messageId, delta)
      : appendLiveMessage(session.messages, { id: messageId, from: "agent", body: delta, at: nowTimestamp(), status: "streaming" });
    return withTranscriptChange(session, change, onTranscriptLimit, {
      ...session,
      status: "streaming",
      streamingMessageId: messageId,
    });
  }
  if (event.type === "message.complete") {
    const messageId = gatewayMessageId(payload) ?? session.streamingMessageId ?? `complete-${event.liveSessionId}-${Date.now()}`;
    const completeText = stringValue(payload.text);
    const exists = session.messages.some((message) => message.id === messageId);
    const replacements = exists
      ? session.messages.map((message) => message.id === messageId ? { ...message, body: completeText || message.body, status: "complete" as const } : message.status === "streaming" ? { ...message, status: "complete" as const } : message)
      : [...session.messages.map((message) => message.status === "streaming" ? { ...message, status: "complete" as const } : message), ...(completeText ? [{ id: messageId, from: "agent" as const, body: completeText, at: nowTimestamp(), status: "complete" as const }] : [])];
    const change = replaceLiveMessages(session.messages, replacements, new Set([messageId]));
    const completedBody = replacements.find((message) => message.id === messageId)?.body
      ?? completeText
      ?? "";
    return withTranscriptChange(session, change, onTranscriptLimit, {
      ...session,
      status: "ready",
      streamingMessageId: undefined,
      pendingInteraction: undefined,
      interruptPending: false,
      interruptOperationId: undefined,
      followUpSuggestions: completedBody.trim()
        ? buildFollowUpSuggestions(completedBody, locale.value)
        : undefined,
    });
  }
  if (event.type === "status.update") {
    return isChatRunActive(session) ? mergeGatewayStatusUpdate(session, payload) : session;
  }
  if (event.type === "session.info") {
    // session.info is an uncorrelated observation and may predate this interrupt.
    // Only the interrupt RPC acknowledgement or a current terminal event can finish it.
    return session;
  }
  if (event.type.startsWith("tool.")) {
    const toolId = stringValue(payload.toolId) ?? stringValue(payload.tool_id) ?? `tool-${event.liveSessionId}`;
    const name = stringValue(payload.name);
    const detail = stringValue(payload.summary) ?? stringValue(payload.status);
    const phase = event.type === "tool.complete" ? "complete" as const : "running" as const;
    const status = phase === "complete" ? "complete" as const : "streaming" as const;
    const body = detail ? `${name ?? "Tool"}: ${detail}` : "";
    const presentation = detail ? undefined : { kind: "tool-fallback" as const, ...(name ? { name } : {}), phase };
    const index = session.messages.findIndex((message) => message.id === toolId);
    const replacements = index >= 0
      ? session.messages.map((message, currentIndex) => currentIndex === index ? { ...message, body, presentation, status } : message)
      : [...session.messages, { id: toolId, from: "tool" as const, body, presentation, at: nowTimestamp(), status }];
    const change = replaceLiveMessages(session.messages, replacements, new Set([toolId]));
    return withTranscriptChange(session, change, onTranscriptLimit, {
      ...session,
      status: event.type === "tool.complete" ? session.status : "streaming",
    });
  }
  if (event.type === "error") {
    const upstreamText = stringValue(payload.message);
    return {
      ...session,
      status: "ready",
      errorMessage: upstreamText ? upstreamMessage(upstreamText) : officeMessage("runtime.chat.hermesGenericError"),
      streamingMessageId: undefined,
      pendingInteraction: undefined,
      interruptPending: false,
      interruptOperationId: undefined,
      messages: session.messages.map((item) => item.status === "streaming" ? { ...item, status: "failed" } : item)
    };
  }
  return session;
}

function withTranscriptChange(
  session: ChatSession,
  change: TranscriptChange,
  onTranscriptLimit: ((reason: Extract<TranscriptChange, { status: "resync-required" }>["reason"]) => void) | undefined,
  next: ChatSession,
): ChatSession {
  if (change.status === "resync-required") {
    onTranscriptLimit?.(change.reason);
    return session;
  }
  return { ...next, messages: change.messages, historyPartial: next.historyPartial === true || change.windowed };
}

function withPendingInteraction(session: ChatSession, interaction: ChatPendingInteraction): ChatSession {
  const current = session.pendingInteraction;
  const pendingInteraction = current?.id === interaction.id
    ? { ...interaction, submitting: current.submitting, error: current.error }
    : interaction;
  return { ...session, status: "waiting", pendingInteraction };
}
