import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ApprovalChoice, ChatMessage, ChatOperationEvidence, ChatPendingInteraction, ChatSession, Profile } from "../domain";
import { chatMessageBody, chatSessionTitle, locale, localizeRuntimeMessage, officeRuntimeMessage, t, type TranslationKey } from "../i18n";
import { activeSessionId, closeSession, interruptSession, officeSnapshot, openSession, reconnectChatSession, respondToApproval, respondToClarification, sendMessage, steerSession } from "../store";
import { canSteerChatSession, canSubmitChatPrompt, isChatRunActive } from "../session-runtime";

export function ChatPane({ session, profile }: { session: ChatSession; profile: Profile }) {
  const [draft, setDraft] = useState("");
  const [announcedOperation, setAnnouncedOperation] = useState<ChatOperationEvidence | undefined>(undefined);
  const announcedOperationKey = useRef("");
  const messageListRef = useRef<HTMLDivElement>(null);
  const isActive = activeSessionId.value === session.id;
  const isLiveChat = session.remoteKind === "stored" || session.remoteKind === "draft";
  const isConnected = !isLiveChat || session.connectionState === "ready";
  const { canCompose, canSteer, runActive, showStop } = chatComposerState(session);
  const canSend = canSubmitChatPrompt(session);
  const transcript = session.messages.filter((message) => message.promptOperation === undefined && message.kind !== "steer");
  const operationEvidence = presentedOperationEvidence(session);
  const timeline = buildChatTimeline(transcript, operationEvidence);
  const displayTitle = chatSessionTitle(session);
  const composerPlaceholder = session.pendingInteraction ? t("chat.answerAbove")
    : !isConnected ? t("chat.connectingPlaceholder")
      : runActive ? t("chat.steerPlaceholder") : t("chat.instruct", { name: profile.name });
  const statusText = useMemo(() => {
    if (session.connectionState === "error") return t("chat.status.error");
    if (session.connectionState === "connecting") return t("chat.status.connecting");
    if (session.connectionState === "disconnected" && isLiveChat) return t("chat.status.reconnecting");
    if (session.historyState === "loading") return t("chat.status.loading");
    if (session.interruptPending) return t("chat.status.stopping");
    if (session.pendingInteraction?.kind === "approval") return t("chat.status.approval");
    if (session.pendingInteraction?.kind === "clarify") return t("chat.status.clarify");
    if (session.status === "waiting") return t("chat.status.waiting");
    if (runActive) return t("chat.status.running");
    return t("chat.status.ready");
  }, [isLiveChat, locale.value, runActive, session.connectionState, session.historyState, session.interruptPending, session.pendingInteraction?.kind, session.status]);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [session.messages.length, session.messages.at(-1)?.body, operationEvidence.length, operationEvidence.at(-1)?.state, session.pendingInteraction?.id]);

  useEffect(() => {
    const next = nextOperationAnnouncement(operationEvidence, announcedOperationKey.current);
    if (!next) return;
    announcedOperationKey.current = next.key;
    setAnnouncedOperation(next.operation);
  }, [operationEvidence.at(-1)?.id, operationEvidence.at(-1)?.state, operationEvidence.at(-1)?.message]);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    if (runActive) {
      if (await steerSession(session.id, draft)) setDraft("");
      return;
    }
    if (!canSend || !draft.trim()) return;
    sendMessage(session.id, draft); setDraft("");
  }

  return (
    <article class={`chat-pane ${isActive ? "is-active" : ""}`} onPointerDown={() => openSession(session.id)}>
      <header class="chat-header">
        <span class="profile-dot" style={{ background: profile.color }} />
        <div>
          <b>{profile.name}</b>
          <span>{displayTitle}</span>
        </div>
        <span class={`chat-state state-${session.connectionState ?? session.status}`}>{statusText}</span>
        <button class="icon-button" onClick={() => closeSession(session.id)} aria-label={t("chat.close", { title: displayTitle })}>×</button>
      </header>

      <div class="message-list" aria-live="polite" ref={messageListRef}>
        {session.errorMessage ? (
          <div class="chat-connection-note is-error" role="alert">
            <span>{localizeRuntimeMessage(session.errorMessage)}</span>
            {isLiveChat && (session.connectionState === "error" || session.historyState === "error") && <button type="button" onClick={() => reconnectChatSession(session.id)}>{session.historyState === "error" ? t("chat.reload") : t("chat.reconnect")}</button>}
          </div>
        ) : session.connectionState === "disconnected" && isLiveChat ? (
          <div class="chat-connection-note"><span>{t("chat.recovering")}</span></div>
        ) : null}
        {session.historyPartial && <div class="chat-connection-note"><span>{session.historyNotice ? localizeRuntimeMessage(session.historyNotice) : t("chat.historyPartial")}</span></div>}
        {timeline.length === 0 ? (
          <div class="empty-chat">
            <span>{session.historyState === "loading" ? t("chat.loadingHistory") : isLiveChat ? t("chat.hermesSession") : t("chat.newThread")}</span>
            <p>{session.historyState === "loading" ? t("chat.loadingSaved") : !isConnected ? t("chat.connectingLive") : runActive ? t("chat.runningPlaceholder") : t("chat.firstInstruction", { name: profile.name })}</p>
          </div>
        ) : timeline.map((item) => item.kind === "operation" ? (
          <ChatOperationEntry key={`operation:${item.operation.id}`} operation={item.operation} />
        ) : (
          <div
            key={`message:${item.message.id}`}
            class={`message message-${item.message.from} message-${item.message.status ?? "complete"}`}
            style={item.message.from === "agent" ? { "--agent-color": profile.color } : undefined}
          >
            <span class="visually-hidden">{item.message.from === "user" ? t("chat.you") : item.message.from === "tool" ? t("chat.tool") : profile.name}</span>
            {item.message.from === "tool" && <span class="message-tool-mark" aria-hidden="true">⚙</span>}
            <p>{chatMessageBody(item.message) || (item.message.status === "streaming" ? "…" : "")}</p>
            <time>{formatChatMessageTime(item.message.at)}</time>
          </div>
        ))}
        {session.pendingInteraction && (
          <ChatInteraction
            sessionId={session.id}
            interaction={session.pendingInteraction}
            connected={session.connectionState === "ready"}
          />
        )}
      </div>
      <span
        class="visually-hidden"
        role={announcedOperation && isUrgentOperation(announcedOperation) ? "alert" : "status"}
        aria-live={announcedOperation && isUrgentOperation(announcedOperation) ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {announcedOperation ? operationAnnouncementText(announcedOperation) : ""}
      </span>

      <form class="composer" onSubmit={(event) => void submit(event)}>
        <textarea
          value={draft}
          disabled={!canCompose}
          aria-busy={session.steerPending === true}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (shouldSubmitComposerKey(event)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={composerPlaceholder}
          aria-label={composerPlaceholder}
          rows={1}
        />
        <div class="composer-actions">
          <button type="submit" disabled={(runActive ? !canSteer : !canSend) || !draft.trim()}>{runActive ? t("chat.steer") : t("chat.send")}</button>
          {showStop && <button type="button" class="interrupt-button" aria-busy={session.interruptPending === true} disabled={session.connectionState !== "ready" || session.interruptPending === true} onClick={() => void interruptSession(session.id)}>{session.interruptPending ? t("chat.stopping") : t("chat.stop")}</button>}
        </div>
      </form>
    </article>
  );
}

export function shouldSubmitComposerKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function formatChatMessageTime(
  value: string,
  selectedLocale: "ja" | "en" = locale.value,
  timeZone?: string
): string {
  if (/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(selectedLocale === "ja" ? "ja-JP" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone })
  }).format(date);
}

function PromptOperationMark({ operation }: { operation: Pick<ChatOperationEvidence, "state" | "message"> }) {
  return (
    <span class={`message-prompt-state is-${operation.state}`}>
      <span>{t(operationStateTranslation(operation.state))}</span>
      {operation.message && <small>{localizeRuntimeMessage(officeRuntimeMessage(operation.message))}</small>}
    </span>
  );
}

function operationStateTranslation(state: ChatOperationEvidence["state"]): TranslationKey {
  return ({
    pending: "chat.prompt.pending",
    accepted: "chat.prompt.accepted",
    rejected: "chat.prompt.rejected",
    unconfirmed: "chat.prompt.unconfirmed",
  } as const)[state];
}

export function presentedOperationEvidence(session: Pick<ChatSession, "messages" | "operationEvidence">): ChatOperationEvidence[] {
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
  return [...(session.operationEvidence ?? []), ...legacy];
}

type ChatTimelineItem =
  | { kind: "message"; message: ChatMessage; sequence: number }
  | { kind: "operation"; operation: ChatOperationEvidence; sequence: number };

export function buildChatTimeline(messages: readonly ChatMessage[], evidence: readonly ChatOperationEvidence[]): ChatTimelineItem[] {
  const timeline: ChatTimelineItem[] = [
    ...messages.map((message, sequence) => ({ kind: "message" as const, message, sequence })),
    ...evidence.map((operation, index) => ({ kind: "operation" as const, operation, sequence: messages.length + index })),
  ];
  const times = timeline.map((item) => comparableTimelineTime(item.kind === "message" ? item.message.at : item.operation.at));
  if (times.some((time) => time === undefined) || new Set(times.map((time) => time?.kind)).size !== 1) return timeline;
  return timeline.sort((left, right) => {
    const leftTime = comparableTimelineTime(left.kind === "message" ? left.message.at : left.operation.at);
    const rightTime = comparableTimelineTime(right.kind === "message" ? right.message.at : right.operation.at);
    if (leftTime && rightTime && leftTime.value !== rightTime.value) return leftTime.value - rightTime.value;
    return left.sequence - right.sequence;
  });
}

export function nextOperationAnnouncement(
  evidence: readonly ChatOperationEvidence[],
  previousKey: string,
): { key: string; operation: ChatOperationEvidence } | undefined {
  const operation = evidence.at(-1);
  if (!operation) return undefined;
  const key = `${operation.id}\0${operation.state}\0${operation.message ?? ""}`;
  return key === previousKey ? undefined : { key, operation };
}

export function operationAnnouncementText(operation: ChatOperationEvidence): string {
  const kind = operation.kind === "steer" ? t("chat.operation.steer") : t("chat.operation.prompt");
  const state = t(operationStateTranslation(operation.state));
  const body = operation.body.length > 160 ? `${operation.body.slice(0, 160)}…` : operation.body;
  return t("chat.operation.announcement", { kind, state, body });
}

function isUrgentOperation(operation: ChatOperationEvidence): boolean {
  return operation.state === "rejected" || operation.state === "unconfirmed";
}

function ChatOperationEntry({ operation }: { operation: ChatOperationEvidence }) {
  const attention = operation.state === "pending" || operation.state === "rejected" || operation.state === "unconfirmed";
  return (
    <details class={`chat-operation-ledger chat-operation is-${operation.state}`} open={attention || undefined} aria-live="off">
      <summary>
        <span><b>{operation.kind === "steer" ? t("chat.operation.steer") : t("chat.operation.prompt")}</b><PromptOperationMark operation={operation} /></span>
        <span class="chat-operation-body">{operation.body}</span>
        <time>{formatChatMessageTime(operation.at)}</time>
      </summary>
      <div class="chat-operation-meta">
        <code>{operation.id}</code>
      </div>
    </details>
  );
}

function comparableTimelineTime(value: string): { kind: "absolute" | "clock"; value: number } | undefined {
  const clock = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)(?::(?<second>[0-5]\d))?$/.exec(value)?.groups;
  if (clock) return { kind: "clock", value: Number(clock.hour) * 3600 + Number(clock.minute) * 60 + Number(clock.second ?? 0) };
  const absolute = Date.parse(value);
  return Number.isNaN(absolute) ? undefined : { kind: "absolute", value: absolute };
}

export function chatComposerState(session: ChatSession): { canCompose: boolean; canSteer: boolean; runActive: boolean; showStop: boolean } {
  const runActive = isChatRunActive(session);
  const canSteer = canSteerChatSession(session);
  const showStop = runActive && (session.remoteKind === "stored" || session.remoteKind === "draft");
  return { runActive, canSteer, canCompose: canSubmitChatPrompt(session) || canSteer, showStop };
}

function ChatInteraction({ sessionId, interaction, connected }: {
  sessionId: string;
  interaction: ChatPendingInteraction;
  connected: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const disabled = !connected || interaction.submitting;

  useEffect(() => setAnswer(""), [interaction.id]);

  if (interaction.kind === "approval") {
    const canApprovePermanently = interaction.allowPermanent
      && officeSnapshot.value?.capabilities.access.allowedOperations.includes("chat.approval.permanent") === true;
    const choices = approvalChoicesForAccess(interaction, canApprovePermanently);
    return (
      <section class="chat-interaction approval-interaction" aria-label={t("chat.approvalAria")}>
        <span class="interaction-kicker">{t("chat.approvalRequired")}</span>
        <h3>{interaction.description || t("chat.approvalFallback")}</h3>
        {interaction.command && <pre><code>{interaction.command}</code></pre>}
        {interaction.error && <p class="interaction-error" role="alert">{localizeRuntimeMessage(interaction.error)}</p>}
        {!connected && <p class="interaction-note">{t("chat.approvalOffline")}</p>}
        <div class="interaction-actions">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              class={choice === "deny" ? "is-deny" : choice === "always" ? "is-permanent" : ""}
              disabled={disabled || (choice === "always" && !canApprovePermanently)}
              onClick={() => void respondToApproval(sessionId, choice)}
            >
              {approvalLabel(choice)}
            </button>
          ))}
        </div>
        {interaction.submitting && <span class="interaction-progress">{t("chat.submitting")}</span>}
      </section>
    );
  }

  return (
    <section class="chat-interaction clarify-interaction" aria-label={t("chat.clarifyAria")}>
      <span class="interaction-kicker">{t("chat.clarification")}</span>
      <h3>{interaction.question}</h3>
      {interaction.error && <p class="interaction-error" role="alert">{localizeRuntimeMessage(interaction.error)}</p>}
      {!connected && <p class="interaction-note">{t("chat.clarifyOffline")}</p>}
      {interaction.choices.length > 0 && (
        <div class="interaction-actions">
          {interaction.choices.map((choice) => (
            <button type="button" key={choice} disabled={disabled} onClick={() => void respondToClarification(sessionId, choice)}>{choice}</button>
          ))}
        </div>
      )}
      <form class="clarify-answer" onSubmit={(event) => {
        event.preventDefault();
        void respondToClarification(sessionId, answer);
      }}>
        <input
          value={answer}
          disabled={disabled}
          onInput={(event) => setAnswer(event.currentTarget.value)}
          placeholder={t("chat.freeAnswer")}
          aria-label={t("chat.answerAria")}
        />
        <button type="submit" disabled={disabled || !answer.trim()}>{t("chat.answer")}</button>
      </form>
      {interaction.submitting && <span class="interaction-progress">{t("chat.submitting")}</span>}
    </section>
  );
}

export function approvalChoicesForAccess(
  interaction: Extract<ChatPendingInteraction, { kind: "approval" }>,
  canApprovePermanently: boolean,
): ApprovalChoice[] {
  return interaction.choices.filter((choice) => choice !== "always" || canApprovePermanently);
}

function approvalLabel(choice: ApprovalChoice): string {
  if (choice === "once") return t("approval.once");
  if (choice === "session") return t("approval.session");
  if (choice === "always") return t("approval.always");
  return t("approval.deny");
}
