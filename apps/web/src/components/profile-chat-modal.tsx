/**
 * Profile Chat Modal — master/detail layout.
 * Left: recent sessions list. Right: up to 4 conversation panes for this profile.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  addProfileChatModalPane,
  closeProfileChatModal,
  createSession,
  ensureSessionConnection,
  MAX_PROFILE_CHAT_MODAL_PANES,
  openMobileWorkspace,
  openProfileSettingsModal,
  openSession,
  profileChatModalId,
  profileChatModalPaneIds,
  profileList,
  removeProfileChatModalPane,
  sessions,
  setProfileChatModalPanes,
} from "../store";
import type { ChatSession, Profile } from "../domain";
import { ChatPane } from "./chat-pane";
import { CharacterPortrait } from "./character-portrait";
import { StatusPill } from "./status-pill";
import { TeamBadges } from "./team-badges";
import { ChatIcon, CloseIcon, SettingsIcon } from "./icons";
import { chatSessionTitle, localizeRuntimeMessage, officeRuntimeMessage, t } from "../i18n";
import { profileDisplayName } from "../profile-names";
import { loadProfileSoul, SettingsApiError } from "../settings-api";
import {
  previewProfileChatModalSize,
  profileChatModalSize,
  setProfileChatModalSize,
} from "../profile-chat-modal-layout";
import { markAppModalResizeEnd, markAppModalResizeStart, shouldIgnoreModalOutsideClose } from "../app-modal-layout";
import { isScheduledSessionHidden } from "../scheduled-sessions";
import { ProfileContextMenu, useProfileContextMenu } from "./profile-context-menu";

const INITIAL_SESSION_COUNT = 10;

export function ProfileChatModal() {
  const profileId = profileChatModalId.value;
  if (!profileId) return null;

  const profile = profileList.value.find((item: Profile) => item.id === profileId);
  if (!profile) return null;

  const profileSessions = useMemo(
    () => sessions.value
      .filter((session) => session.profileId === profileId && !isScheduledSessionHidden(session))
      .sort((a, b) => {
        const left = a.updatedAt ?? a.createdAt ?? "";
        const right = b.updatedAt ?? b.createdAt ?? "";
        return right.localeCompare(left);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileId, sessions.value.length, sessions.value.map((session) => session.id + session.status + (session.updatedAt ?? "")).join("|")],
  );

  const displayName = profileDisplayName(profile);
  const hasSessions = profileSessions.length > 0;
  const {
    menu,
    menuRef,
    closeMenu,
    openSessionMenu,
  } = useProfileContextMenu();
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [soulOpen, setSoulOpen] = useState(false);
  const [soulLoading, setSoulLoading] = useState(false);
  const [soulError, setSoulError] = useState<string | null>(null);
  const [soulContent, setSoulContent] = useState<string | null>(null);

  useEffect(() => {
    setShowAllSessions(false);
    setDropActive(false);
    setDropNote(null);
    setSoulOpen(false);
    setSoulLoading(false);
    setSoulError(null);
    setSoulContent(null);
  }, [profileId]);

  useEffect(() => {
    const onWindowResize = () => {
      setProfileChatModalSize(profileChatModalSize.value);
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  const visibleSessions = showAllSessions
    ? profileSessions
    : profileSessions.slice(0, INITIAL_SESSION_COUNT);
  const hiddenSessionCount = Math.max(0, profileSessions.length - visibleSessions.length);
  const profileSessionIdsKey = profileSessions.map((session) => session.id).join("|");
  useEffect(() => {
    // Drop panes that no longer belong to this profile / no longer exist.
    const allowed = new Set(profileSessions.map((session) => session.id));
    const next = profileChatModalPaneIds.value.filter((id) => allowed.has(id));
    if (next.length !== profileChatModalPaneIds.value.length) {
      setProfileChatModalPanes(next);
    }
  }, [profileId, profileSessionIdsKey]);

  const openPaneIds = profileChatModalPaneIds.value.filter((id) =>
    profileSessions.some((session) => session.id === id),
  );
  const openPanes = openPaneIds
    .map((id) => profileSessions.find((session) => session.id === id))
    .filter((session): session is ChatSession => session !== undefined);

  useEffect(() => {
    for (const session of openPanes) ensureSessionConnection(session.id);
  }, [openPaneIds.join("|")]);

  const startNewChat = () => {
    const sessionId = createSession(profile.id);
    if (!sessionId) return;
    if (!addProfileChatModalPane(sessionId)) {
      // If pane slots are full, replace the oldest pane.
      const current = profileChatModalPaneIds.value;
      setProfileChatModalPanes([...current.slice(1), sessionId].slice(-MAX_PROFILE_CHAT_MODAL_PANES));
    }
  };

  const acceptSessionDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const sessionId = event.dataTransfer?.getData("application/x-hermes-session");
    if (!sessionId) return;
    const session = sessions.value.find((item) => item.id === sessionId);
    if (!session || session.profileId !== profile.id) {
      setDropNote(t("profile.modalDropWrongProfile"));
      window.setTimeout(() => setDropNote(null), 2200);
      return;
    }
    if (profileChatModalPaneIds.value.includes(sessionId)) {
      ensureSessionConnection(sessionId);
      setDropNote(null);
      return;
    }
    if (profileChatModalPaneIds.value.length >= MAX_PROFILE_CHAT_MODAL_PANES) {
      setDropNote(t("profile.modalPaneLimit"));
      window.setTimeout(() => setDropNote(null), 2200);
      return;
    }
    addProfileChatModalPane(sessionId);
    setDropNote(null);
  };

  const openSoulPreview = async () => {
    setSoulOpen(true);
    if (soulContent !== null || soulLoading) return;
    setSoulLoading(true);
    setSoulError(null);
    try {
      const soul = await loadProfileSoul(profile.id);
      setSoulContent(soul.content);
    } catch (reason) {
      const message = reason instanceof SettingsApiError
        ? localizeRuntimeMessage(officeRuntimeMessage(reason.message))
        : t("profile.soulPreviewFailed");
      setSoulError(message);
    } finally {
      setSoulLoading(false);
    }
  };

  const modalSize = profileChatModalSize.value;
  type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  const resizePointerId = useRef<number | null>(null);
  const resizeOrigin = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    edge: ResizeEdge;
  } | null>(null);

  const stopDocumentResizeListeners = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    stopDocumentResizeListeners.current?.();
    stopDocumentResizeListeners.current = null;
  }, []);

  const beginResize = (edge: ResizeEdge) => (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const origin = {
      x: event.clientX,
      y: event.clientY,
      width: profileChatModalSize.value.width,
      height: profileChatModalSize.value.height,
      edge,
    };
    resizePointerId.current = event.pointerId;
    resizeOrigin.current = origin;
    markAppModalResizeStart();

    const onMove = (moveEvent: PointerEvent) => {
      if (resizePointerId.current !== moveEvent.pointerId || !resizeOrigin.current) return;
      moveEvent.preventDefault();
      const current = resizeOrigin.current;
      const dx = moveEvent.clientX - current.x;
      const dy = moveEvent.clientY - current.y;
      let width = current.width;
      let height = current.height;
      if (current.edge === "e" || current.edge === "ne" || current.edge === "se") width = current.width + dx;
      if (current.edge === "w" || current.edge === "nw" || current.edge === "sw") width = current.width - dx;
      if (current.edge === "s" || current.edge === "se" || current.edge === "sw") height = current.height + dy;
      if (current.edge === "n" || current.edge === "ne" || current.edge === "nw") height = current.height - dy;
      previewProfileChatModalSize({ width, height });
    };

    const onUp = (upEvent: PointerEvent) => {
      if (resizePointerId.current !== upEvent.pointerId) return;
      upEvent.preventDefault();
      upEvent.stopPropagation();
      resizePointerId.current = null;
      resizeOrigin.current = null;
      setProfileChatModalSize(profileChatModalSize.value);
      markAppModalResizeEnd();
      stopDocumentResizeListeners.current?.();
      stopDocumentResizeListeners.current = null;
    };

    stopDocumentResizeListeners.current?.();
    const onClick = (clickEvent: MouseEvent) => {
      if (!shouldIgnoreModalOutsideClose()) return;
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("click", onClick, true);
    stopDocumentResizeListeners.current = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("click", onClick, true);
    };
  };

  const resizeHandles: Array<{ edge: ResizeEdge; className: string }> = [
    { edge: "n", className: "is-n" },
    { edge: "s", className: "is-s" },
    { edge: "e", className: "is-e" },
    { edge: "w", className: "is-w" },
    { edge: "ne", className: "is-ne" },
    { edge: "nw", className: "is-nw" },
    { edge: "se", className: "is-se" },
    { edge: "sw", className: "is-sw" },
  ];


  return (
    <div
      class="profile-chat-modal-layer"
      data-modal-affordance="true"
      onPointerDown={(event) => {
        if (shouldIgnoreModalOutsideClose()) return;
        if (event.target === event.currentTarget) closeProfileChatModal();
      }}
      onClick={(event) => {
        if (shouldIgnoreModalOutsideClose()) return;
        if (event.target === event.currentTarget) closeProfileChatModal();
      }}
    >
      <button class="profile-chat-modal-scrim" type="button" aria-label={t("common.close")} onClick={() => { if (!shouldIgnoreModalOutsideClose()) closeProfileChatModal(); }} />
      <section
        class={`profile-chat-modal ${hasSessions ? "has-sessions" : "is-empty"}`}
        style={{
          width: `${modalSize.width}px`,
          height: hasSessions ? `${modalSize.height}px` : undefined,
        }}
      >
        <header class="profile-chat-modal-head">
          <div class="profile-chat-modal-identity">
            <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--modal" decorative />
            <div class="profile-chat-modal-copy">
              <div class="profile-chat-modal-title-row">
                <h2 title={displayName}>{displayName}</h2>
                <button
                  type="button"
                  class={`profile-chat-soul-button ${soulOpen ? "is-open" : ""}`}
                  title={t("profile.viewSoul")}
                  aria-label={t("profile.viewSoul")}
                  aria-expanded={soulOpen}
                  onClick={() => {
                    if (soulOpen) setSoulOpen(false);
                    else void openSoulPreview();
                  }}
                >
                  {t("profile.viewSoul")}
                </button>
                <StatusPill status={profile.status} />
              </div>
              <div class="profile-chat-modal-meta">
                <TeamBadges profileId={profile.id} />
                {hasSessions && (
                  <span class="profile-chat-session-count">{profileSessions.length} {t("office.chats")}</span>
                )}
              </div>
            </div>
          </div>
          <div class="profile-chat-modal-actions">
            <button
              type="button"
              class="profile-chat-new profile-chat-new--header"
              title={t("profile.newChat")}
              aria-label={t("profile.newChat")}
              onClick={startNewChat}
            >
              <ChatIcon width={18} height={18} />
            </button>
            <button
              type="button"
              class="quiet-button"
              title={t("profile.settings")}
              aria-label={t("profile.settings")}
              onClick={() => {
                closeProfileChatModal();
                openProfileSettingsModal(profileId);
              }}
            >
              <SettingsIcon width={18} height={18} />
            </button>
            <button
              type="button"
              class="profile-chat-modal-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={closeProfileChatModal}
            >
              <CloseIcon width={18} height={18} />
            </button>
          </div>
        </header>

        {soulOpen && (
          <div class="profile-chat-soul-preview" role="region" aria-label={t("profile.soulPreviewTitle")}>
            <div class="profile-chat-soul-preview-head">
              <b>{t("profile.soulPreviewTitle")}</b>
              <div class="profile-chat-soul-preview-actions">
                <button
                  type="button"
                  class="profile-chat-soul-open-settings"
                  onClick={() => {
                    closeProfileChatModal();
                    openProfileSettingsModal(profileId, "soul");
                  }}
                >
                  {t("profile.soulPreviewOpenSettings")}
                </button>
                <button type="button" class="profile-chat-soul-close" onClick={() => setSoulOpen(false)} aria-label={t("common.close")} title={t("common.close")}>
                  <CloseIcon width={16} height={16} />
                </button>
              </div>
            </div>
            {soulLoading ? (
              <p class="profile-chat-soul-status">{t("profile.soulPreviewLoading")}</p>
            ) : soulError ? (
              <p class="profile-chat-soul-status is-error">{soulError}</p>
            ) : soulContent?.trim() ? (
              <pre class="profile-chat-soul-body">{soulContent}</pre>
            ) : (
              <p class="profile-chat-soul-status">{t("profile.soulPreviewEmpty")}</p>
            )}
          </div>
        )}

        <div
          class={`profile-chat-modal-body ${hasSessions ? "is-split" : "is-empty-body"} ${dropActive ? "is-drop-target" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDropActive(false);
          }}
          onDrop={acceptSessionDrop}
        >
          {hasSessions ? (
            <>
              <aside class="profile-chat-session-pane" aria-label={t("profile.openChats")}>
                <div class="profile-chat-session-pane-head">
                  <b>{t("profile.recentChats")}</b>
                  <span>{openPanes.length}/{MAX_PROFILE_CHAT_MODAL_PANES}</span>
                </div>
                <div class="profile-chat-session-list">
                  {visibleSessions.map((session) => (
                    <SessionListItem
                      key={session.id}
                      session={session}
                      profileId={profile.id}
                      selected={openPaneIds.includes(session.id)}
                      onSelect={() => {
                        if (!addProfileChatModalPane(session.id)) {
                          setDropNote(t("profile.modalPaneLimit"));
                          window.setTimeout(() => setDropNote(null), 2200);
                        }
                      }}
                      onContextMenu={(event) => openSessionMenu(event, session.id, profile.id)}
                    />
                  ))}
                </div>
                {!showAllSessions && hiddenSessionCount > 0 && (
                  <button
                    type="button"
                    class="profile-chat-show-more"
                    onClick={() => setShowAllSessions(true)}
                  >
                    {t("profile.showMoreChats", { count: hiddenSessionCount })}
                  </button>
                )}
                {showAllSessions && profileSessions.length > INITIAL_SESSION_COUNT && (
                  <button
                    type="button"
                    class="profile-chat-show-more"
                    onClick={() => setShowAllSessions(false)}
                  >
                    {t("profile.showRecentChats")}
                  </button>
                )}
                {dropActive && <p class="profile-chat-drop-hint">{t("profile.modalDropToAddPane")}</p>}
                {dropNote && <p class="profile-chat-drop-note">{dropNote}</p>}
              </aside>

              <div class={`profile-chat-detail-pane panes-${Math.min(Math.max(openPanes.length, 1), MAX_PROFILE_CHAT_MODAL_PANES)}`}>
                {openPanes.length > 0 ? (
                  openPanes.map((session) => (
                    <div class="profile-chat-modal-pane" key={session.id}>
                      <ChatPane
                        session={session}
                        profile={profile}
                        onClosePane={() => removeProfileChatModalPane(session.id)}
                      />
                    </div>
                  ))
                ) : (
                  <div class="profile-chat-empty">
                    <p>{t("profile.modalDropToAddPane")}</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div class="profile-chat-empty">
              <p>{t("profile.noChats")}</p>
              <button type="button" class="profile-chat-new" onClick={startNewChat}>
                {t("profile.newChat")}
              </button>
            </div>
          )}
        </div>
        {hasSessions && resizeHandles.map((handle) => (
          <div
            key={handle.edge}
            class={`profile-chat-modal-resize ${handle.className}`}
            role="separator"
            aria-orientation={handle.edge === "n" || handle.edge === "s" ? "horizontal" : handle.edge === "e" || handle.edge === "w" ? "vertical" : undefined}
            aria-label={t("profile.chatModalResize")}
            title={t("profile.chatModalResize")}
            onPointerDown={beginResize(handle.edge)}
          />
        ))}
      </section>
      {menu && (
        <ProfileContextMenu
          menu={menu}
          menuRef={menuRef}
          onClose={closeMenu}
          onOpenSession={(sessionId) => {
            openSession(sessionId, { workspace: true });
            openMobileWorkspace();
            closeMenu();
          }}
        />
      )}
    </div>
  );
}

function SessionListItem({
  session,
  selected,
  onSelect,
  onContextMenu,
}: {
  session: ChatSession;
  profileId: string;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const title = chatSessionTitle(session);
  const updatedAt = session.updatedAt ?? session.createdAt;
  const timeStr = updatedAt
    ? new Date(updatedAt).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  const status = session.status === "streaming" ? "working" : session.status === "waiting" ? "waiting" : "idle";

  return (
    <button
      type="button"
      class={`profile-chat-session-item ${selected ? "is-selected" : ""}`}
      draggable
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDragStart={(event) => {
        event.dataTransfer?.setData("application/x-hermes-session", session.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      }}
      aria-current={selected ? "true" : undefined}
      title={t("profile.openInWorkspace")}
    >
      <span class="profile-chat-session-item-main">
        <b title={title}>{title}</b>
        {timeStr && <small>{timeStr}</small>}
      </span>
      <StatusPill status={status} />
    </button>
  );
}
