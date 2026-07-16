import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ApprovalChoice, ChatPendingInteraction, ChatSession, Profile } from "../domain";
import { activeSessionId, closeSession, interruptSession, openSession, reconnectChatSession, respondToApproval, respondToClarification, sendMessage } from "../store";

export function ChatPane({ session, profile }: { session: ChatSession; profile: Profile }) {
  const [draft, setDraft] = useState("");
  const messageListRef = useRef<HTMLDivElement>(null);
  const isActive = activeSessionId.value === session.id;
  const isLiveChat = session.remoteKind === "stored" || session.remoteKind === "draft";
  const isConnected = !isLiveChat || session.connectionState === "ready";
  const canSend = isConnected && !session.pendingInteraction;
  const statusText = useMemo(() => {
    if (session.connectionState === "error") return "接続エラー";
    if (session.connectionState === "connecting") return "接続中";
    if (session.connectionState === "disconnected" && isLiveChat) return "再接続待ち";
    if (session.historyState === "loading") return "履歴読込中";
    if (session.pendingInteraction?.kind === "approval") return "承認待ち";
    if (session.pendingInteraction?.kind === "clarify") return "回答待ち";
    if (session.status === "streaming") return "実行中";
    if (session.status === "waiting") return "入力待ち";
    return "準備完了";
  }, [isLiveChat, session.connectionState, session.historyState, session.pendingInteraction?.kind, session.status]);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [session.messages.length, session.messages.at(-1)?.body, session.pendingInteraction?.id]);

  function submit(event: Event): void {
    event.preventDefault();
    sendMessage(session.id, draft);
    setDraft("");
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
        <button class="icon-button" onClick={() => closeSession(session.id)} aria-label={`${session.title}を閉じる`}>×</button>
      </header>

      <div class="message-list" aria-live="polite" ref={messageListRef}>
        {session.errorMessage ? (
          <div class="chat-connection-note is-error" role="alert">
            <span>{session.errorMessage}</span>
            {isLiveChat && (session.connectionState === "error" || session.historyState === "error") && <button type="button" onClick={() => reconnectChatSession(session.id)}>{session.historyState === "error" ? "再読込" : "再接続"}</button>}
          </div>
        ) : session.connectionState === "disconnected" && isLiveChat ? (
          <div class="chat-connection-note"><span>Chat接続を復旧しています。履歴はそのまま保持されます。</span></div>
        ) : null}
        {session.messages.length === 0 ? (
          <div class="empty-chat">
            <span>{session.historyState === "loading" ? "LOADING HISTORY" : isLiveChat ? "HERMES SESSION" : "NEW THREAD"}</span>
            <p>{session.historyState === "loading" ? "保存された会話を読み込んでいます。" : !canSend ? "Live Sessionを安全に接続しています。" : `${profile.name}に最初の指示を送ります。`}</p>
          </div>
        ) : session.messages.map((message) => (
          <div key={message.id} class={`message message-${message.from} message-${message.status ?? "complete"}`}>
            <span class="message-source">{message.from === "user" ? "You" : message.from === "tool" ? "Tool" : profile.name}</span>
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

      <form class="composer" onSubmit={submit}>
        <textarea
          value={draft}
          disabled={!canSend || session.status === "streaming"}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={session.pendingInteraction ? "上の確認に回答してください" : !isConnected ? "Live Sessionに接続中…" : session.status === "streaming" ? "実行中。停止すると次の指示を送れます" : `${profile.name}に指示…`}
          rows={1}
        />
        {session.status === "streaming" && isLiveChat ? (
          <button type="button" class="interrupt-button" disabled={session.connectionState !== "ready"} onClick={() => interruptSession(session.id)}>停止</button>
        ) : (
          <button type="submit" disabled={!canSend || !draft.trim()}>送信</button>
        )}
      </form>
    </article>
  );
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
    return (
      <section class="chat-interaction approval-interaction" aria-label="Hermesの操作承認">
        <span class="interaction-kicker">APPROVAL REQUIRED</span>
        <h3>{interaction.description || "Hermesが操作の許可を求めています"}</h3>
        {interaction.command && <pre><code>{interaction.command}</code></pre>}
        {interaction.error && <p class="interaction-error" role="alert">{interaction.error}</p>}
        {!connected && <p class="interaction-note">再接続後に選択できます。この承認は保持されています。</p>}
        <div class="interaction-actions">
          {interaction.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              class={choice === "deny" ? "is-deny" : choice === "always" ? "is-permanent" : ""}
              disabled={disabled || (choice === "always" && !interaction.allowPermanent)}
              onClick={() => void respondToApproval(sessionId, choice)}
            >
              {approvalLabel(choice)}
            </button>
          ))}
        </div>
        {interaction.submitting && <span class="interaction-progress">送信中…</span>}
      </section>
    );
  }

  return (
    <section class="chat-interaction clarify-interaction" aria-label="Hermesからの確認質問">
      <span class="interaction-kicker">CLARIFICATION</span>
      <h3>{interaction.question}</h3>
      {interaction.error && <p class="interaction-error" role="alert">{interaction.error}</p>}
      {!connected && <p class="interaction-note">再接続後に回答できます。この質問は保持されています。</p>}
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
          placeholder="自由入力で回答"
          aria-label="確認質問への回答"
        />
        <button type="submit" disabled={disabled || !answer.trim()}>回答</button>
      </form>
      {interaction.submitting && <span class="interaction-progress">送信中…</span>}
    </section>
  );
}

function approvalLabel(choice: ApprovalChoice): string {
  if (choice === "once") return "今回だけ許可";
  if (choice === "session") return "このSession中は許可";
  if (choice === "always") return "常に許可";
  return "拒否";
}
