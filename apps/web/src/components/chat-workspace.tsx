import { useMemo } from "preact/hooks";
import { mobileInspectorOpen, mobileWorkspaceOpen, profileList, sessions, openSessionIds } from "../store";
import { ChatPane } from "./chat-pane";

export function ChatWorkspace() {
  const openSessions = useMemo(
    () => openSessionIds.value.map((id) => sessions.value.find((session) => session.id === id)).filter(Boolean),
    [openSessionIds.value, sessions.value]
  );

  if (openSessions.length === 0) {
    return (
      <section class="workspace-empty">
        <span>NO OPEN THREADS</span>
        <p>オフィスのキャラクターを選ぶと、ここに会話が開きます。</p>
      </section>
    );
  }

  return (
    <section class="chat-workspace-shell">
      <header class="mobile-workspace-bar">
        <button onClick={() => { mobileWorkspaceOpen.value = false; }}>← Profiles</button>
        <b>Chats</b>
        <button onClick={() => { mobileInspectorOpen.value = true; mobileWorkspaceOpen.value = false; }}>Profile設定</button>
      </header>
      <div class={`chat-workspace panes-${Math.min(openSessions.length, 4)}`} aria-label="開いている会話">
        {openSessions.map((session) => {
          if (!session) return null;
          const profile = profileList.value.find((item) => item.id === session.profileId);
          return profile ? <ChatPane key={session.id} session={session} profile={profile} /> : null;
        })}
      </div>
    </section>
  );
}
