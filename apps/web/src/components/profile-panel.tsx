import type { InspectorTab, SettingsTab } from "../domain";
import {
  closeMobileRoute,
  createSession,
  inspectorTab,
  mobileInspectorOpen,
  navigateToSurface,
  openMobileWorkspace,
  openSession,
  selectedProfile,
  selectedProfileSessions,
  settingsTab
} from "../store";
import { StatusPill } from "./status-pill";
import { CharacterPortrait } from "./character-portrait";
import { AvatarPicker } from "./avatar-picker";
import { InfoTip } from "./info-tip";
import { TeamBadges } from "./team-badges";
import { useEffect, useState } from "preact/hooks";
import { chatSessionTitle, localizeRuntimeMessage, t, type TranslationKey } from "../i18n";
import { loadMoreSessions, sessionInventoryState } from "../inventory";
import { COMPACT_OVERLAY_VIEWPORT, useMobileOverlay } from "./use-mobile-overlay";
import { inspectorTabIsSelected } from "../navigation-state";
import { profileDisplayName, profileSecondaryName, profileStoredDisplayName, setProfileDisplayName } from "../profile-names";

const tabs: { id: InspectorTab; label: TranslationKey }[] = [
  { id: "chat", label: "profile.chat" },
  { id: "profile", label: "settings.identity" },
  { id: "skills", label: "settings.skills" },
  { id: "memory", label: "settings.memory" }
];

const settingsRoutes: Record<Exclude<InspectorTab, "chat">, SettingsTab> = {
  profile: "soul",
  skills: "skills",
  memory: "memory"
};

const routeCopy: Record<Exclude<InspectorTab, "chat">, { title: TranslationKey; description: TranslationKey }> = {
  profile: {
    title: "settings.identity",
    description: "profile.identityDescription"
  },
  skills: {
    title: "profile.skillsTitle",
    description: "profile.skillsDescription"
  },
  memory: {
    title: "settings.memoryProvider",
    description: "profile.memoryDescription"
  }
};

function openLiveSettings(tab: Exclude<InspectorTab, "chat">): void {
  inspectorTab.value = tab;
  settingsTab.value = settingsRoutes[tab];
  navigateToSurface("settings");
}

export function createProfileSession(profileId: string): boolean {
  const sessionId = createSession(profileId);
  if (sessionId === undefined) return false;
  openMobileWorkspace();
  return true;
}

function ChatList() {
  const profile = selectedProfile.value;
  const inventory = sessionInventoryState.value;
  if (!profile) return null;
  return (
    <div class="panel-section">
      <button class="new-chat-button" onClick={() => createProfileSession(profile.id)}>{t("profile.newChat")}</button>
      <div class="session-list">
        {selectedProfileSessions.value.map((session) => (
          <button key={session.id} onClick={() => { openSession(session.id); openMobileWorkspace(); }}>
            <span>{chatSessionTitle(session)}</span>
            <small>{session.status === "streaming" ? t("profile.running") : t("profile.open")}</small>
          </button>
        ))}
      </div>
      {inventory.hasMore && <button class="secondary-button inventory-more" disabled={inventory.loading} onClick={() => void loadMoreSessions()}>{inventory.loading ? t("inventory.loading") : t("inventory.showMore")}</button>}
      {inventory.truncated && !inventory.hasMore && <small class="inventory-note">{t("inventory.truncated")}</small>}
      {inventory.error && <small class="inventory-note inventory-note--error">{localizeRuntimeMessage(inventory.error)}</small>}
    </div>
  );
}

function LiveSettingsRoute({ tab }: { tab: Exclude<InspectorTab, "chat"> }) {
  const profile = selectedProfile.value;
  if (!profile) return null;
  const copy = routeCopy[tab];
  return (
    <div class="panel-section">
      <article class="profile-live-route">
        <div class="heading-info-group">
          <h3>{t(copy.title)}</h3>
          <InfoTip text={`${t(copy.description)} ${t("profile.liveNote")}`} align="end" side="bottom" />
        </div>
        <dl>
          <div><dt>{t("profile.target")}</dt><dd>{profileDisplayName(profile)}</dd></div>
          <div><dt>{t("profile.id")}</dt><dd>{profile.id}</dd></div>
        </dl>
        <button type="button" onClick={() => openLiveSettings(tab)}>{t("profile.openLive")}</button>
      </article>
    </div>
  );
}

export function ProfilePanel() {
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [nameEditorOpen, setNameEditorOpen] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const mobileOverlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open: mobileInspectorOpen.value,
    onClose: closeMobileRoute,
    viewport: COMPACT_OVERLAY_VIEWPORT,
  });
  const profile = selectedProfile.value;
  useEffect(() => {
    setNameEditorOpen(false);
    setDisplayNameDraft("");
  }, [profile?.id]);
  if (!profile) return null;
  const displayName = profileDisplayName(profile);
  const secondaryName = profileSecondaryName(profile);
  const savedDisplayName = profileStoredDisplayName(
    profile.id,
    profile.displayName?.trim() || profile.nameJa?.trim() || "",
  );
  const isDefaultProfile = profile.id === "default";
  const titleId = "mobile-profile-panel-title";
  return (
    <aside
      ref={mobileOverlay.ref}
      class={`profile-panel ${mobileInspectorOpen.value ? "is-mobile-open" : ""}`}
      aria-label={mobileOverlay.active ? undefined : t("profile.details")}
      aria-labelledby={mobileOverlay.active ? titleId : undefined}
      aria-modal={mobileOverlay.active ? "true" : undefined}
      role={mobileOverlay.active ? "dialog" : undefined}
      tabIndex={mobileOverlay.active ? -1 : undefined}
    >
      <header class="profile-panel-head">
        <button class="mobile-close" data-mobile-overlay-initial-focus onClick={closeMobileRoute} aria-label={t("common.close")}>←</button>
        <button class="profile-avatar-button" type="button" onClick={() => setAvatarPickerOpen(true)} aria-label={t("profile.changeAvatar", { name: displayName })}>
          <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--panel" decorative />
          <span>{t("profile.change")}</span>
        </button>
        <div class="profile-panel-title">
          <div class="profile-panel-title-row">
            <h2 id={titleId}>{displayName}</h2>
            <button
              class="profile-name-edit"
              type="button"
              aria-label={t("profile.editName")}
              title={isDefaultProfile ? `${t("profile.editName")} — ${t("profile.defaultIdNote")}` : t("profile.editName")}
              onClick={() => { setDisplayNameDraft(savedDisplayName); setNameEditorOpen((current) => !current); }}
            >✎</button>
          </div>
          {secondaryName && <small class="profile-name-secondary">{secondaryName}</small>}
          {profile.role && <p>{profile.role}</p>}
          <TeamBadges profileId={profile.id} />
        </div>
        <StatusPill status={profile.status} />
      </header>
      {nameEditorOpen && (
        <form
          class="profile-name-editor"
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
      <nav class="panel-tabs" aria-label={t("profile.settings")}>
        {tabs.map((tab) => (
          <button
            class={inspectorTabIsSelected(inspectorTab.value, tab.id) ? "is-active" : ""}
            aria-pressed={inspectorTabIsSelected(inspectorTab.value, tab.id)}
            onClick={() => {
              if (tab.id === "chat") inspectorTab.value = "chat";
              else openLiveSettings(tab.id);
            }}
            key={tab.id}
          >
            {t(tab.label)}
          </button>
        ))}
      </nav>
      {inspectorTab.value === "chat"
        ? <ChatList />
        : <LiveSettingsRoute tab={inspectorTab.value} />}
      {avatarPickerOpen && <AvatarPicker profileId={profile.id} profileName={displayName} onClose={() => setAvatarPickerOpen(false)} />}
    </aside>
  );
}
