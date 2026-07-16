import type { InspectorTab, SettingsTab } from "../domain";
import {
  activeSurface,
  createSession,
  inspectorTab,
  mobileInspectorOpen,
  mobileWorkspaceOpen,
  openSession,
  profileList,
  selectedProfile,
  selectedProfileSessions,
  settingsTab
} from "../store";
import { StatusPill } from "./status-pill";
import { CharacterPortrait } from "./character-portrait";
import { AvatarPicker } from "./avatar-picker";
import { InfoTip } from "./info-tip";
import { useState } from "preact/hooks";
import { t, type TranslationKey } from "../i18n";
import { loadMoreSessions, sessionInventoryState } from "../inventory";

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

const routeCopy: Record<Exclude<InspectorTab, "chat">, { code: string; title: TranslationKey; description: TranslationKey }> = {
  profile: {
    code: "SOUL / LIVE",
    title: "settings.identity",
    description: "profile.identityDescription"
  },
  skills: {
    code: "SKILLS / LIVE",
    title: "profile.skillsTitle",
    description: "profile.skillsDescription"
  },
  memory: {
    code: "MEMORY / LIVE",
    title: "settings.memoryProvider",
    description: "profile.memoryDescription"
  }
};

function openLiveSettings(tab: Exclude<InspectorTab, "chat">): void {
  inspectorTab.value = tab;
  settingsTab.value = settingsRoutes[tab];
  activeSurface.value = "settings";
  mobileInspectorOpen.value = false;
}

function ChatList() {
  const profile = selectedProfile.value;
  const inventory = sessionInventoryState.value;
  if (!profile) return null;
  return (
    <div class="panel-section">
      <button class="new-chat-button" onClick={() => createSession(profile.id)}>{t("profile.newChat")}</button>
      <div class="session-list">
        {selectedProfileSessions.value.map((session) => (
          <button key={session.id} onClick={() => { openSession(session.id); mobileInspectorOpen.value = false; mobileWorkspaceOpen.value = true; }}>
            <span>{session.title}</span>
            <small>{session.status === "streaming" ? t("profile.running") : t("profile.open")}</small>
          </button>
        ))}
      </div>
      {inventory.hasMore && <button class="secondary-button inventory-more" disabled={inventory.loading} onClick={() => void loadMoreSessions()}>{inventory.loading ? t("inventory.loading") : t("inventory.showMore")}</button>}
      {inventory.truncated && !inventory.hasMore && <small class="inventory-note">{t("inventory.truncated")}</small>}
      {inventory.error && <small class="inventory-note inventory-note--error">{inventory.error}</small>}
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
        <span>{copy.code}</span>
        <h3>{t(copy.title)} <InfoTip text={`${t(copy.description)} ${t("profile.liveNote")}`} align="end" side="bottom" /></h3>
        <dl>
          <div><dt>{t("profile.target")}</dt><dd>{profile.name}</dd></div>
          <div><dt>{t("profile.id")}</dt><dd>{profile.id}</dd></div>
        </dl>
        <button type="button" onClick={() => openLiveSettings(tab)}>{t("profile.openLive")}</button>
      </article>
    </div>
  );
}

export function ProfilePanel() {
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const profile = selectedProfile.value;
  if (!profile) return null;
  const profileIndex = profileList.value.findIndex((candidate) => candidate.id === profile.id);
  return (
    <aside class={`profile-panel ${mobileInspectorOpen.value ? "is-mobile-open" : ""}`} aria-label={t("profile.details")}>
      <header class="profile-panel-head">
        <button class="mobile-close" onClick={() => { mobileInspectorOpen.value = false; }} aria-label={t("common.close")}>←</button>
        <button class="profile-avatar-button" type="button" onClick={() => setAvatarPickerOpen(true)} aria-label={t("profile.changeAvatar", { name: profile.name })}>
          <CharacterPortrait profileId={profile.id} profileName={profile.name} profileIndex={profileIndex} class="character-portrait--panel" decorative />
          <span>{t("profile.change")}</span>
        </button>
        <div><h2>{profile.name}</h2>{profile.role && <p>{profile.role}</p>}</div>
        <StatusPill status={profile.status} />
      </header>
      <nav class="panel-tabs" aria-label={t("profile.settings")}>
        {tabs.map((tab) => (
          <button
            class={inspectorTab.value === tab.id ? "is-active" : ""}
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
      {avatarPickerOpen && <AvatarPicker profileId={profile.id} profileName={profile.name} profileIndex={profileIndex} onClose={() => setAvatarPickerOpen(false)} />}
    </aside>
  );
}
