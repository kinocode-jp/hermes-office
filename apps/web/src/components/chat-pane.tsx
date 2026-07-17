import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ApprovalChoice, ChatPendingInteraction, ChatSession, Profile } from "../domain";
import { locale, localizeRuntimeMessage, t } from "../i18n";
import { activeSessionId, closeSession, interruptSession, officeSnapshot, openSession, reconnectChatSession, respondToApproval, respondToClarification, sendMessage, steerSession } from "../store";
import { canSteerChatSession, canSubmitChatPrompt, isChatRunActive } from "../session-runtime";

export function ChatPane({ session, profile }: { session: ChatSession; profile: Profile }) {
  const [draft, setDraft] = useState("");
  const messageListRef = useRef<HTMLDivElement>(null);
  const isActive = activeSessionId.value === session.id;
  const isLiveChat = session.remoteKind === "stored" || session.remoteKind === "draft";
  const isConnected = !isLiveChat || session.connectionState === "ready";
  const { canCompose, canSteer, runActive, showStop } = chatComposerState(session);
  const canSend = canSubmitChatPrompt(session);
  const composerPlaceholder = session.pendingInteraction ? t("chat.answerAbove")
    : !isConnected ? t("chat.connectingPlaceholder")
      : runActive ? t("chat.steerPlaceholder") : t("chat.instruct", { name: profile.name });
  const statusText = useMemo(() => {
    if (session.connectionState === "error") return t("chat.status.error");
    if (session.connectionState === "connecting") return t("chat.status.connecting");
    if (session.connectionState === "disconnected" && isLiveChat) return t("chat.status.reconnecting");
    if (session.historyState === "loading") return t("chat.status.loading");
    if (session.pendingInteraction?.kind === "approval") return t("chat.status.approval");
    if (session.pendingInteraction?.kind === "clarify") return t("chat.status.clarify");
    if (session.status === "waiting") return t("chat.status.waiting");
    if (runActive) return t("chat.status.running");
    return t("chat.status.ready");
  }, [isLiveChat, locale.value, runActive, session.connectionState, session.historyState, session.pendingInteraction?.kind, session.status]);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [session.messages.length, session.messages.at(-1)?.body, session.pendingInteraction?.id]);

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
          <span>{session.title}</span>
        </div>
        <span class={`chat-state state-${session.connectionState ?? session.status}`}>{statusText}</span>
        <button class="icon-button" onClick={() => closeSession(session.id)} aria-label={t("chat.close", { title: session.title })}>×</button>
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
        {session.messages.length === 0 ? (
          <div class="empty-chat">
            <span>{session.historyState === "loading" ? t("chat.loadingHistory") : isLiveChat ? t("chat.hermesSession") : t("chat.newThread")}</span>
            <p>{session.historyState === "loading" ? t("chat.loadingSaved") : !isConnected ? t("chat.connectingLive") : runActive ? t("chat.runningPlaceholder") : t("chat.firstInstruction", { name: profile.name })}</p>
          </div>
        ) : session.messages.map((message) => (
          <div
            key={message.id}
            class={`message message-${message.from} message-${message.status ?? "complete"}`}
            style={message.from === "agent" ? { "--agent-color": profile.color } : undefined}
          >
            <span class="visually-hidden">{message.kind === "steer" ? t("chat.steerMessage") : message.from === "user" ? t("chat.you") : message.from === "tool" ? t("chat.tool") : profile.name}</span>
            {message.kind === "steer" && <span class="message-steer-mark">{t("chat.steerMessage")}</span>}
            {message.from === "tool" && <span class="message-tool-mark" aria-hidden="true">⚙</span>}
            <p>{message.body || (message.status === "streaming" ? "…" : "")}</p>
            <time>{message.at}</time>
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

      <form class="composer" onSubmit={(event) => void submit(event)}>
        <textarea
          value={draft}
          disabled={!canCompose}
          aria-busy={session.steerPending === true}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
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
          {showStop && <button type="button" class="interrupt-button" disabled={session.connectionState !== "ready"} onClick={() => interruptSession(session.id)}>{t("chat.stop")}</button>}
        </div>
      </form>
    </article>
  );
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
