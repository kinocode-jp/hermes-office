import { useState } from "preact/hooks";
import { useMobileOverlay } from "./use-mobile-overlay";
import { CharacterPortrait } from "./character-portrait";
import { StatusPill } from "./status-pill";
import { TeamBadges } from "./team-badges";
import {
  closeProfileDetailModal,
  createSession,
  openMobileWorkspace,
  openProfileSettingsModal,
  openSession,
  profileDetailModalId,
  profileList,
  sessions,
  tasks,
} from "../store";
import { chatSessionTitle, t } from "../i18n";
import { profileDisplayName, profileSecondaryName, setProfileDisplayName } from "../profile-names";
import { createProfileSession } from "./profile-panel";

const statusKey = {
  working: "status.working",
  waiting: "status.waiting",
  idle: "status.idle",
  blocked: "status.blocked",
} as const;

export function ProfileDetailModal() {
  const profile = profileList.value.find((item) => item.id === profileDetailModalId.value);
  const open = profileDetailModalId.value !== null && profile !== undefined;
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open,
    onClose: closeProfileDetailModal,
    viewport: "(min-width: 0px)",
  });
  const [nameEditorOpen, setNameEditorOpen] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");

  if (!open || !profile) return null;

  const displayName = profileDisplayName(profile);
  const secondary = profileSecondaryName(profile);
  const savedDisplayName = profile.displayName?.trim() || profile.nameJa?.trim() || "";
  const isDefaultProfile = profile.id === "default";
  const profileTasks = tasks.value.filter((task) => task.assigneeId === profile.id);
  const activeTasks = profileTasks.filter((task) => task.status === "running" || task.status === "ready" || task.status === "blocked" || task.status === "review");
  const otherTasks = profileTasks.filter((task) => !activeTasks.includes(task));
  const profileSessions = sessions.value.filter((session) => session.profileId === profile.id);
  const liveSession = profileSessions.find((session) => session.status === "streaming" || session.status === "waiting");

  return (
    <div class="profile-detail-modal-layer" data-modal-affordance="true">
      <button class="profile-detail-modal-scrim" type="button" aria-label={t("common.close")} onClick={closeProfileDetailModal} />
      <section
        ref={overlay.ref}
        class="profile-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-detail-modal-title"
        tabIndex={-1}
      >
        <header class="profile-detail-modal-head">
          <div class="profile-detail-modal-identity">
            <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--modal" decorative />
            <div>
              <span>{t("profile.details")}</span>
              <div class="profile-detail-title-row">
                <h2 id="profile-detail-modal-title">{displayName}</h2>
                <button
                  type="button"
                  class="profile-name-edit"
                  aria-label={t("profile.editName")}
                  title={isDefaultProfile ? `${t("profile.editName")} — ${t("profile.defaultIdNote")}` : t("profile.editName")}
                  onClick={() => {
                    setDisplayNameDraft(savedDisplayName);
                    setNameEditorOpen((current) => !current);
                  }}
                >✎</button>
              </div>
              {secondary && <small>{secondary}</small>}
              <small>{profile.id}</small>
            </div>
          </div>
          <button
            type="button"
            class="profile-detail-modal-close"
            data-mobile-overlay-initial-focus
            onClick={closeProfileDetailModal}
            aria-label={t("common.close")}
          >
            ×
          </button>
        </header>

        {nameEditorOpen && (
          <form
            class="profile-name-editor profile-detail-name-editor"
            onSubmit={(event) => {
              event.preventDefault();
              setProfileDisplayName(profile.id, displayNameDraft);
              setNameEditorOpen(false);
            }}
          >
            <label>
              <span>{t("profile.displayName")}</span>
              <input
                autoFocus
                type="text"
                value={displayNameDraft}
                maxLength={40}
                placeholder={profile.name}
                onInput={(event) => setDisplayNameDraft(event.currentTarget.value)}
              />
            </label>
            <div>
              <button type="submit">{t("profile.saveName")}</button>
              <button type="button" onClick={() => setNameEditorOpen(false)}>{t("common.cancel")}</button>
            </div>
            <small>{t("profile.nameLocalNote")}</small>
            {isDefaultProfile && <small>{t("profile.defaultIdNote")}</small>}
          </form>
        )}

        <div class="profile-detail-modal-body">
          <dl class="profile-detail-meta">
            <div>
              <dt>{t("profile.status")}</dt>
              <dd class="profile-detail-status">
                <StatusPill status={profile.status} />
                <span>{t(statusKey[profile.status])}</span>
              </dd>
            </div>
            <div>
              <dt>{t("profile.role")}</dt>
              <dd>{profile.role?.trim() || t("profile.roleEmpty")}</dd>
            </div>
            <div>
              <dt>{t("profile.sessions")}</dt>
              <dd>{profile.sessions}</dd>
            </div>
            <div>
              <dt>{t("profile.tasks")}</dt>
              <dd>{profile.taskCount}</dd>
            </div>
          </dl>

          <div class="profile-detail-teams">
            <h3>{t("profile.teams")}</h3>
            <TeamBadges profileId={profile.id} />
          </div>

          {liveSession && (
            <section class="profile-detail-section">
              <h3>{t("profile.currentActivity")}</h3>
              <p class="profile-detail-activity">{chatSessionTitle(liveSession)}</p>
            </section>
          )}

          <section class="profile-detail-section">
            <h3>{t("profile.currentTasks")}</h3>
            {activeTasks.length === 0 && otherTasks.length === 0 ? (
              <p class="profile-detail-empty">{t("profile.noTasks")}</p>
            ) : (
              <ul class="profile-detail-task-list">
                {activeTasks.map((task) => (
                  <li key={task.id}>
                    <b>{task.title}</b>
                    <small>{task.status} · {task.id}</small>
                    {(task.latestSummary || task.body) && <p>{task.latestSummary ?? task.body}</p>}
                  </li>
                ))}
                {otherTasks.slice(0, 6).map((task) => (
                  <li key={task.id} class="is-muted">
                    <b>{task.title}</b>
                    <small>{task.status} · {task.id}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section class="profile-detail-section">
            <h3>{t("profile.openChats")}</h3>
            {profileSessions.length === 0 ? (
              <p class="profile-detail-empty">{t("profile.noChats")}</p>
            ) : (
              <ul class="profile-detail-session-list">
                {profileSessions.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      onClick={() => {
                        openSession(session.id);
                        openMobileWorkspace();
                        closeProfileDetailModal();
                      }}
                    >
                      <b>{chatSessionTitle(session)}</b>
                      <small>{session.status}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer class="profile-detail-modal-actions">
          <button
            type="button"
            class="secondary-button"
            onClick={() => {
              openProfileSettingsModal(profile.id);
              closeProfileDetailModal();
            }}
          >
            {t("profile.settings")}
          </button>
          <button
            type="button"
            class="primary-button"
            onClick={() => {
              const existing = sessions.value.find((session) => session.profileId === profile.id);
              if (existing) {
                openSession(existing.id);
                openMobileWorkspace();
              } else if (!createProfileSession(profile.id)) {
                createSession(profile.id);
                openMobileWorkspace();
              }
              closeProfileDetailModal();
            }}
          >
            {t("profile.openChat")}
          </button>
        </footer>
      </section>
    </div>
  );
}
