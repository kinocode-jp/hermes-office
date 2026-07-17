import { useMemo } from "preact/hooks";
import type { ChatSession } from "../domain";
import { chatSessionTitle, t } from "../i18n";
import { activeSessionId, mobileInspectorOpen, mobileWorkspaceOpen, openSession, profileList, sessions, openSessionIds } from "../store";
import { ChatPane } from "./chat-pane";
import { InfoTip } from "./info-tip";
import { useMobileOverlay } from "./use-mobile-overlay";

export function ChatWorkspace() {
  const mobileOverlay = useMobileOverlay<HTMLElement>({
    kind: "route",
    open: mobileWorkspaceOpen.value,
    onClose: () => { mobileWorkspaceOpen.value = false; },
  });
  const openSessions = useMemo(
    () => openSessionIds.value
      .map((id) => sessions.value.find((session) => session.id === id))
      .filter((session): session is ChatSession => session !== undefined),
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
    <section
      ref={mobileOverlay.ref}
      class="chat-workspace-shell"
      role={mobileOverlay.active ? "region" : undefined}
      aria-labelledby={mobileOverlay.active ? "mobile-workspace-title" : undefined}
      tabIndex={mobileOverlay.active ? -1 : undefined}
    >
      <header class="mobile-workspace-bar">
        <button data-mobile-overlay-initial-focus onClick={() => { mobileWorkspaceOpen.value = false; }}>← {t("workspace.profiles")}</button>
        <b id="mobile-workspace-title">{t("workspace.chats", { count: openSessions.length })}</b>
        <button onClick={() => { mobileInspectorOpen.value = true; mobileWorkspaceOpen.value = false; }}>{t("workspace.profileSettings")}</button>
      </header>
      <nav class="mobile-chat-tabs" aria-label={t("workspace.switchChats")}>
        {openSessions.map((session) => {
          if (!session) return null;
          const profileName = profileList.value.find((profile) => profile.id === session.profileId)?.name ?? session.profileId;
          const tab = mobileChatTabPresentation(session, profileName, openSessions);
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
  session: Pick<ChatSession, "id" | "profileId" | "title" | "titlePresentation">,
  profileName: string,
  siblings: readonly Pick<ChatSession, "id" | "profileId" | "title" | "titlePresentation">[] = [session]
): { profileName: string; sessionTitle: string; accessibleLabel: string } {
  const sessionTitle = chatSessionTitle(session);
  const matching = siblings.filter((candidate) => (
    candidate.profileId === session.profileId && chatSessionTitle(candidate) === sessionTitle
  ));
  const ordinal = matching.findIndex((candidate) => candidate.id === session.id) + 1;
  const disambiguatedTitle = matching.length > 1 && ordinal > 0 ? `${sessionTitle} · ${ordinal}` : sessionTitle;
  return { profileName, sessionTitle: disambiguatedTitle, accessibleLabel: `${profileName} — ${disambiguatedTitle}` };
}
