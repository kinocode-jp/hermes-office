import { useMemo, useState } from "preact/hooks";
import type { ChatSession, Profile } from "../domain";
import { activeSessionId, closeSession, openSession, sendMessage } from "../store";

export function ChatPane({ session, profile }: { session: ChatSession; profile: Profile }) {
  const [draft, setDraft] = useState("");
  const isActive = activeSessionId.value === session.id;
  const statusText = useMemo(() => {
    if (session.status === "streaming") return "実行中";
    if (session.status === "waiting") return "入力待ち";
    return "準備完了";
  }, [session.status]);

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
        <span class={`chat-state state-${session.status}`}>{statusText}</span>
        <button class="icon-button" onClick={() => closeSession(session.id)} aria-label={`${session.title}を閉じる`}>×</button>
      </header>

      <div class="message-list" aria-live="polite">
        {session.messages.length === 0 ? (
          <div class="empty-chat">
            <span>{session.readOnly ? "HERMES SESSION" : "NEW THREAD"}</span>
            <p>{session.readOnly ? "履歴と送信は安全なChat接続を準備中です。" : `${profile.name}に最初の指示を送ります。`}</p>
          </div>
        ) : session.messages.map((message) => (
          <div key={message.id} class={`message message-${message.from}`}>
            <span class="message-source">{message.from === "user" ? "You" : message.from === "tool" ? "Tool" : profile.name}</span>
            <p>{message.body}</p>
            <time>{message.at}</time>
          </div>
        ))}
      </div>

      <form class="composer" onSubmit={submit}>
        <textarea
          value={draft}
          disabled={session.readOnly}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={session.readOnly ? "Chat接続は次の実装段階です" : `${profile.name}に指示…`}
          rows={1}
        />
        <button type="submit" disabled={session.readOnly || !draft.trim()}>送信</button>
      </form>
    </article>
  );
}
