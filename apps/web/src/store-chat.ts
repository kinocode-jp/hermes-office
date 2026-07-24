import type { ChatGatewayEvent, ChatHistoryResult, ChatPromptResult, ChatTarget } from "./chat-api";
import type { ApprovalChoice, ChatConnectionState, ChatMessage, ChatOperationEvidence, ChatSession } from "./domain";
import { boundedOperationEvidence, interruptChatRun, steerChatRun } from "./chat-run-actions";
import { canSubmitChatPrompt, isChatRunActive } from "./session-runtime";
import { sessionNeedsCardSeed } from "./kanban-ask";
import {
  reconcileChatSessionConnecting,
  reconcileChatSessionDisconnected,
  reconcileChatSessionError,
  reconcileChatSessionReady,
  type ChatSessionReadyRuntime,
} from "./chat-session-reconciliation";
import { nowTimestamp } from "./chat-store-utils";
import { resolvedCreateModelPrefs } from "./chat-model-prefs";
import { summarizePromptForEvidence } from "./chat-attachments";
import { buildFollowUpSuggestions } from "./chat-suggestions";
import { boundedTranscriptSuffix } from "./live-transcript";
import { officeMessage, officeRuntimeMessage, type RuntimeMessage, locale } from "./i18n";
import { reduceChatGatewayEvent } from "./chat-gateway-reducer";
import {
  chatSocketState,
  officeRuntimeHooks,
  sessions,
} from "./store-state";

export { reduceChatGatewayEvent } from "./chat-gateway-reducer";

export function sendMessage(sessionId: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session || !canSubmitChatPrompt(session)) return;
  const operationId = crypto.randomUUID();
  const evidenceBody = summarizePromptForEvidence(trimmed);
  sessions.value = sessions.value.map((item) =>
    item.id === sessionId
      ? {
          ...item,
          status: "streaming",
          errorMessage: undefined,
          followUpSuggestions: undefined,
          ...(item.remoteKind === "demo" ? {
            messages: [...item.messages, { id: `prompt-${operationId}`, from: "user" as const, body: evidenceBody, at: nowTimestamp() }],
          } : {
            operationEvidence: boundedOperationEvidence([
              ...(item.operationEvidence ?? []),
              { id: operationId, kind: "prompt", body: evidenceBody, at: nowTimestamp(), state: "pending" },
            ]),
          })
        }
      : item
  );
  if (session.remoteKind === "demo") {
    // Demo: echo a short agent reply so follow-up chips can be exercised offline.
    window.setTimeout(() => {
      updateChatSession(sessionId, (item) => {
        if (item.id !== sessionId) return item;
        const reply = locale.value === "en"
          ? `Got it.\n\nReceived: ${trimmed.slice(0, 200)}\n\nShall we continue?`
          : `了解しました。\n\n受信: ${trimmed.slice(0, 200)}\n\n次に進めますか？`;
        return {
          ...item,
          status: "ready",
          messages: [
            ...item.messages,
            { id: `agent-${operationId}`, from: "agent" as const, body: reply, at: nowTimestamp(), status: "complete" as const },
          ],
          followUpSuggestions: buildFollowUpSuggestions(reply, locale.value),
        };
      });
    }, 350);
    return;
  }
  const submission = officeRuntimeHooks.submitChatPrompt(sessionId, trimmed, operationId);
  if (submission === undefined) updatePromptOperation(sessionId, operationId, { status: "accepted" });
  else {
    void submission.then((result) => {
      updatePromptOperation(sessionId, operationId, result);
    }, (reason) => {
      updatePromptOperation(sessionId, operationId, {
        status: "unconfirmed",
        message: reason instanceof Error ? reason.message : "Prompt submission could not be confirmed.",
      });
    });
  }
}

export function applySessionModelPrefs(
  sessionId: string,
  provider: string,
  model: string,
  reasoningEffort = "",
): void {
  updateChatSession(sessionId, (session) => ({
    ...session,
    ...(provider ? { provider } : { provider: undefined }),
    ...(model ? { model } : { model: undefined }),
    ...(reasoningEffort ? { reasoningEffort } : { reasoningEffort: undefined }),
  }));
}

export function clearFollowUpSuggestions(sessionId: string): void {
  updateChatSession(sessionId, (session) => (
    session.followUpSuggestions ? { ...session, followUpSuggestions: undefined } : session
  ));
}

export function refreshFollowUpSuggestions(sessionId: string): void {
  updateChatSession(sessionId, (session) => {
    if (isChatRunActive(session) || session.status !== "ready") return session;
    const lastAgent = [...session.messages].reverse().find((message) => message.from === "agent" && message.status !== "streaming");
    if (!lastAgent?.body.trim()) return session;
    return { ...session, followUpSuggestions: buildFollowUpSuggestions(lastAgent.body, locale.value) };
  });
}

export async function steerSession(sessionId: string, body: string): Promise<boolean> {
  return steerChatRun(sessions, officeRuntimeHooks.steerChatSession, sessionId, body);
}

export async function interruptSession(sessionId: string): Promise<boolean> {
  return await interruptChatRun(sessions, officeRuntimeHooks.interruptChatSession, sessionId);
}

export async function respondToClarification(sessionId: string, answer: string): Promise<void> {
  const trimmed = answer.trim();
  const session = sessions.value.find((item) => item.id === sessionId);
  const pending = session?.pendingInteraction;
  if (!trimmed || session?.connectionState !== "ready" || pending?.kind !== "clarify" || pending.submitting) return;
  markInteractionSubmitting(sessionId, pending.id);
  try {
    await officeRuntimeHooks.respondClarify(sessionId, pending.requestId, trimmed);
    clearInteraction(sessionId, pending.id);
  } catch {
    failInteraction(sessionId, pending.id, officeMessage("runtime.chat.answerFailed"));
  }
}

export async function respondToApproval(sessionId: string, choice: ApprovalChoice): Promise<void> {
  const session = sessions.value.find((item) => item.id === sessionId);
  const pending = session?.pendingInteraction;
  if (session?.connectionState !== "ready" || pending?.kind !== "approval" || pending.submitting) return;
  if (!pending.choices.includes(choice) || (choice === "always" && !pending.allowPermanent)) return;
  markInteractionSubmitting(sessionId, pending.id);
  try {
    await officeRuntimeHooks.respondApproval(sessionId, pending.approvalId, choice);
    clearInteraction(sessionId, pending.id);
  } catch {
    failInteraction(sessionId, pending.id, officeMessage("runtime.chat.approvalFailed"));
  }
}

export function reconnectChatSession(sessionId: string): void {
  const session = sessions.value.find((item) => item.id === sessionId);
  const target = session ? chatTarget(session) : undefined;
  if (target) officeRuntimeHooks.ensureChatSession(target);
}

export function setChatSocketState(state: ChatConnectionState, message = ""): void {
  chatSocketState.value = { state, message: message ? officeRuntimeMessage(message) : officeMessage("runtime.chat.waiting") };
}

export function setChatHistoryLoading(sessionId: string, resetTranscript = false): void {
  updateChatSession(sessionId, (session) => {
    const migrated = migrateLegacyPromptEvidence(session);
    return {
      ...migrated,
      historyState: "loading",
      ...(resetTranscript ? {
        messages: [],
        streamingMessageId: undefined,
        historyPartial: false,
        historyNotice: undefined,
      } : {}),
    };
  });
}

export function applyChatHistory(sessionId: string, history: ChatMessage[], resolvedStoredSessionId?: string, result?: ChatHistoryResult): void {
  updateChatSession(sessionId, (session) => {
    const migrated = migrateLegacyPromptEvidence(session);
    const historyIds = new Set(history.map((message) => message.id));
    const localMessages = migrated.messages
      .filter((message) => !historyIds.has(message.id));
    const merged = boundedTranscriptSuffix([...history, ...localMessages]);
    return {
      ...migrated,
      ...(resolvedStoredSessionId ? { storedSessionId: resolvedStoredSessionId, remoteKind: "stored" as const } : {}),
      historyState: "loaded",
      historyPartial: result?.partial === true || merged.truncated, historyNotice: result?.error ? officeRuntimeMessage(result.error) : undefined,
      errorMessage: session.connectionState === "error" ? session.errorMessage : undefined,
      messages: merged.messages
    };
  });
}

function updatePromptOperation(sessionId: string, operationId: string, result: ChatPromptResult): void {
  updateChatSession(sessionId, (session) => {
    let found = false;
    const evidence = (session.operationEvidence ?? []).map((operation) => {
      if (operation.id !== operationId || operation.kind !== "prompt" || operation.state !== "pending") return operation;
      found = true;
      return {
        ...operation,
        state: result.status,
        ...(result.status === "accepted" ? { message: undefined } : { message: result.message }),
      };
    });
    if (!found) return session;
    return {
      ...session,
      operationEvidence: evidence,
      ...(result.status === "rejected" || result.status === "unconfirmed" ? { status: "ready" as const } : {}),
    };
  });
}

export function reconcilePromptOperationsWithHistory(local: readonly ChatOperationEvidence[], _history: readonly ChatMessage[]): ChatOperationEvidence[] {
  return boundedOperationEvidence(local);
}

function migrateLegacyPromptEvidence(session: ChatSession): ChatSession {
  const legacy = session.messages.flatMap<ChatOperationEvidence>((message): ChatOperationEvidence[] => {
    if (message.promptOperation) return [{
      id: message.promptOperation.id, kind: "prompt" as const, body: message.body, at: message.at,
      state: message.promptOperation.state,
      ...(message.promptOperation.message ? { message: message.promptOperation.message } : {}),
    }];
    return message.kind === "steer"
      ? [{ id: message.id, kind: "steer" as const, body: message.body, at: message.at, state: "accepted" as const }]
      : [];
  });
  if (legacy.length === 0) return session;
  return {
    ...session,
    messages: session.messages.filter((message) => message.promptOperation === undefined && message.kind !== "steer"),
    operationEvidence: boundedOperationEvidence([...(session.operationEvidence ?? []), ...legacy]),
  };
}

export function setChatHistoryError(sessionId: string, message: string): void {
  updateChatSession(sessionId, (session) => ({ ...session, historyState: "error", errorMessage: officeRuntimeMessage(message) }));
}

export function setChatSessionConnecting(sessionId: string): void {
  updateChatSession(sessionId, reconcileChatSessionConnecting);
}

export function setChatSessionReady(sessionId: string, liveSessionId: string, storedSessionId?: string, runtime?: ChatSessionReadyRuntime): void {
  updateChatSession(sessionId, (session) => reconcileChatSessionReady(session, liveSessionId, storedSessionId, runtime));
  tryFlushCardSeed(sessionId);
}

/**
 * Card-ask sessions keep pendingCardSeed as context for the first user-authored
 * message. Studio never auto-sends that context; ChatPane prepends it on submit.
 */
export function tryFlushCardSeed(_sessionId: string): void {
  // Intentionally a no-op: asking an assignee opens a chat, then the user types.
}

/** Consume the one-shot card context after the user sends their first prompt. */
export function consumeCardSeed(sessionId: string): string | undefined {
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session || !sessionNeedsCardSeed(session)) return undefined;
  const seed = session.pendingCardSeed?.trim();
  updateChatSession(sessionId, (item) => ({
    ...item,
    sourceCardSeeded: true,
    pendingCardSeed: undefined,
  }));
  return seed || undefined;
}

export function setChatSessionDisconnected(sessionId: string): void {
  updateChatSession(sessionId, reconcileChatSessionDisconnected);
}

export function setChatSessionError(sessionId: string, message: string): void {
  updateChatSession(sessionId, (session) => reconcileChatSessionError(session, officeRuntimeMessage(message)));
}

export function applyChatGatewayEvent(sessionId: string, event: ChatGatewayEvent): "resync-required" | void {
  let resyncRequired = false;
  updateChatSession(sessionId, (session) => reduceChatGatewayEvent(session, event, () => { resyncRequired = true; }));
  return resyncRequired ? "resync-required" : undefined;
}

function markInteractionSubmitting(sessionId: string, interactionId: string): void {
  updateChatSession(sessionId, (session) => session.pendingInteraction?.id === interactionId
    ? { ...session, pendingInteraction: { ...session.pendingInteraction, submitting: true, error: undefined } }
    : session);
}

function clearInteraction(sessionId: string, interactionId: string): void {
  updateChatSession(sessionId, (session) => session.pendingInteraction?.id === interactionId
    ? { ...session, status: "streaming", pendingInteraction: undefined }
    : session);
}

function failInteraction(sessionId: string, interactionId: string, error: RuntimeMessage): void {
  updateChatSession(sessionId, (session) => session.pendingInteraction?.id === interactionId
    ? { ...session, pendingInteraction: { ...session.pendingInteraction, submitting: false, error } }
    : session);
}

function chatTarget(session: ChatSession): ChatTarget | undefined {
  if (!session.remoteKind || session.remoteKind === "demo") return undefined;
  // Session effort was set via apply (live allowlist) or createSession from validated prefs.
  const resolved = resolvedCreateModelPrefs({
    provider: session.provider ?? "",
    model: session.model ?? "",
    reasoningEffort: session.reasoningEffort ?? "",
  });
  return {
    clientSessionId: session.id,
    profileId: session.profileId,
    ...(session.storedSessionId ? { storedSessionId: session.storedSessionId } : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.provider ? { provider: resolved.provider } : {}),
    ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
  };
}

function updateChatSession(sessionId: string, update: (session: ChatSession) => ChatSession): void {
  sessions.value = sessions.value.map((session) => session.id === sessionId ? update(session) : session);
}
