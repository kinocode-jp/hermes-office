import { useMemo } from "preact/hooks";
import type { ChatSession } from "../domain";
import { chatSessionTitle, t } from "../i18n";
import { activeSessionId, mobileInspectorOpen, mobileWorkspaceOpen, openSession, profileList, sessions, openSessionIds } from "../store";
import { ChatPane } from "./chat-pane";
import { InfoTip } from "./info-tip";

export function ChatWorkspace() {
  const openSessions = useMemo(
    () => openSessionIds.value.map((id) => sessions.value.find((session) => session.id === id)).filter(Boolean),
    [openSessionIds.value, sessions.value]
  );

  if (openSessions.length === 0) {
    return (
      <section class="workspace-empty">
        <span>{t("workspace.emptyKicker")}</span>
        <InfoTip text={t("workspace.empty")} />
      </section>
    );
  }

  return (
    <section class="chat-workspace-shell">
      <header class="mobile-workspace-bar">
        <button onClick={() => { mobileWorkspaceOpen.value = false; }}>← {t("workspace.profiles")}</button>
        <b>{t("workspace.chats", { count: openSessions.length })}</b>
        <button onClick={() => { mobileInspectorOpen.value = true; mobileWorkspaceOpen.value = false; }}>{t("workspace.profileSettings")}</button>
      </header>
      <nav class="mobile-chat-tabs" aria-label={t("workspace.switchChats")}>
        {openSessions.map((session) => {
          if (!session) return null;
          const profileName = profileList.value.find((profile) => profile.id === session.profileId)?.name ?? session.profileId;
          const tab = mobileChatTabPresentation(session, profileName);
          return (
            <button
              key={session.id}
              type="button"
              class={activeSessionId.value === session.id ? "is-active" : ""}
              aria-label={tab.accessibleLabel}
              aria-current={activeSessionId.value === session.id ? "page" : undefined}
              onClick={() => openSession(session.id)}
            >
              <span>{tab.profileName}</span>
              <small title={tab.sessionTitle}>{tab.sessionTitle}</small>
            </button>
          );
        })}
      </nav>
      <div class={`chat-workspace panes-${Math.min(openSessions.length, 4)}`} aria-label={t("workspace.openChats")}>
        {openSessions.map((session) => {
          if (!session) return null;
          const profile = profileList.value.find((item) => item.id === session.profileId);
          return profile ? <ChatPane key={session.id} session={session} profile={profile} /> : null;
        })}
      </div>
    </section>
  );
}

export function mobileChatTabPresentation(
  session: Pick<ChatSession, "title" | "titlePresentation">,
  profileName: string
): { profileName: string; sessionTitle: string; accessibleLabel: string } {
  const sessionTitle = chatSessionTitle(session);
  return { profileName, sessionTitle, accessibleLabel: `${profileName} — ${sessionTitle}` };
}
