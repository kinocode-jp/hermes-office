/**
 * Profile Chat Modal — shows all sessions for a profile as accordions.
 * Latest session is expanded by default; others are collapsed.
 * Header has icons to open profile detail / settings.
 */
import { useState, useMemo, useRef, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { sessions, profileList, openProfileDetailModal, openProfileSettingsModal, closeProfileChatModal, profileChatModalId } from "../store";
import type { ChatSession, Profile } from "../domain";
import { ChatPane } from "./chat-pane";
import { CharacterPortrait } from "./character-portrait";
import { StatusPill } from "./status-pill";
import { TeamBadges } from "./team-badges";
import { chatSessionTitle, t } from "../i18n";
import { profileDisplayName } from "../profile-names";

export function ProfileChatModal() {
  const profileId = profileChatModalId.value;
  if (!profileId) return null;

  const profile = profileList.value.find((p: Profile) => p.id === profileId);
  if (!profile) return null;

  const profileSessions = useMemo(
    () => sessions.value
      .filter((s) => s.profileId === profileId)
      .sort((a, b) => {
        const ta = a.updatedAt ?? a.createdAt ?? "";
        const tb = b.updatedAt ?? b.createdAt ?? "";
        return tb.localeCompare(ta); // newest first
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileId, sessions.value.length, sessions.value.map(s => s.id + s.status + (s.updatedAt ?? "")).join("|")]
  );

  const displayName = profileDisplayName(profile);

  return (
    <div
      class="profile-chat-modal-layer"
      data-modal-affordance="true"
      onPointerDown={(e) => { if (e.target === e.currentTarget) closeProfileChatModal(); }}
    >
      <button class="profile-chat-modal-scrim" type="button" aria-label={t("common.close")} onClick={closeProfileChatModal} />
      <section class="profile-chat-modal">
        <header class="profile-chat-modal-head">
          <div class="profile-chat-modal-identity">
            <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--modal" decorative />
            <div>
              <h2>{displayName}</h2>
              <div class="profile-chat-modal-meta">
                <StatusPill status={profile.status} />
                <TeamBadges profileId={profile.id} />
                {profileSessions.length > 0 && (
                  <span class="profile-chat-session-count">{profileSessions.length} {t("office.chats")}</span>
                )}
              </div>
            </div>
          </div>
          <div class="profile-chat-modal-actions">
            <button
              type="button"
              class="quiet-button"
              title={t("profile.details")}
              aria-label={t("profile.details")}
              onClick={() => { closeProfileChatModal(); openProfileDetailModal(profileId); }}
            >ℹ</button>
            <button
              type="button"
              class="quiet-button"
              title={t("profile.settings")}
              aria-label={t("profile.settings")}
              onClick={() => { closeProfileChatModal(); openProfileSettingsModal(profileId); }}
            >⚙</button>
            <button
              type="button"
              class="profile-chat-modal-close"
              aria-label={t("common.close")}
              onClick={closeProfileChatModal}
            >×</button>
          </div>
        </header>
        <div class="profile-chat-modal-body">
          {profileSessions.length === 0 ? (
            <p class="profile-chat-empty">{t("profile.noChats")}</p>
          ) : (
            profileSessions.map((session, index) => (
              <SessionAccordion
                key={session.id}
                session={session}
                profile={profile}
                defaultOpen={index === 0}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function SessionAccordion({
  session,
  profile,
  defaultOpen,
}: {
  session: ChatSession;
  profile: Profile;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const title = chatSessionTitle(session);
  const updatedAt = session.updatedAt ?? session.createdAt;
  const timeStr = updatedAt ? new Date(updatedAt).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div class={`profile-chat-accordion ${open ? "is-open" : ""}`}>
      <button
        type="button"
        class="profile-chat-accordion-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span class="profile-chat-accordion-chevron">{open ? "▾" : "▸"}</span>
        <span class="profile-chat-accordion-title">{title}</span>
        <span class="profile-chat-accordion-meta">
                <StatusPill status={session.status === "streaming" ? "working" : session.status === "waiting" ? "waiting" : "idle"} />
          {timeStr && <time>{timeStr}</time>}
        </span>
      </button>
      {open && (
        <div class="profile-chat-accordion-body">
          <ChatPane session={session} profile={profile} />
        </div>
      )}
    </div>
  );
}
