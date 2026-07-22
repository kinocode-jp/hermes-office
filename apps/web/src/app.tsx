import { ChatWorkspace } from "./components/chat-workspace";
import { KanbanBoard } from "./components/kanban-board";
import { LiveSettings } from "./components/live-settings";
import { OfficeScene } from "./components/office-scene";
import { ProfilePanel } from "./components/profile-panel";
import { TeamsPanel } from "./components/teams-panel";
import { DeviceLogin } from "./components/device-login";
import { AppearanceSettings } from "./components/appearance-settings";
import { ProfileCommand } from "./components/profile-command";
import { ProfileSettingsModal } from "./components/profile-settings-modal";
import { ProfileDetailModal } from "./components/profile-detail-modal";
import { ProfileChatModal } from "./components/profile-chat-modal";
import { RecurringJobsPanel } from "./components/recurring-jobs-panel";
import { SideRail, type SideRailNavItem } from "./components/side-rail";
import { WorkspaceLayout } from "./components/workspace-layout";
import { locale, localizeRuntimeMessage, setLocale, t, type TranslationKey } from "./i18n";
import { BoardIcon, HomeIcon, SettingsIcon, UsersIcon } from "./components/icons";
import type { SettingsTab, Surface } from "./domain";
import { profileDisplayName } from "./profile-names";
import { officeWindowOpen } from "./office-window";
import { sidebarWidth } from "./sidebar-layout";
import { activeSurface, mobileWorkspaceOpen, navigateToSurface, officeAccess, officeConnection, openMobileInspector, openSessionIds, profileList, retryOfficeServer, selectedProfile, settingsTab } from "./store";
import { persistUiNavPreferences } from "./ui-nav-prefs";
import { rememberSurfaceScroll, restoreSurfaceScroll, type SurfaceScrollPosition } from "./surface-scroll";
import { useLayoutEffect, useRef } from "preact/hooks";

const navItems: { id: Surface; icon: SideRailNavItem["icon"]; label: TranslationKey }[] = [
  { id: "office", icon: HomeIcon, label: "nav.office" },
  { id: "kanban", icon: BoardIcon, label: "nav.kanban" },
  { id: "teams", icon: UsersIcon, label: "nav.teams" },
  // Agent settings (global + profile) live under Settings only — not a separate "Library".
  { id: "settings", icon: SettingsIcon, label: "nav.settings" }
];

export function App() {
  const mainStageRef = useRef<HTMLElement>(null);
  const surfaceScrollPositions = useRef(new Map<Surface, SurfaceScrollPosition>());
  useLayoutEffect(() => {
    if (mainStageRef.current) restoreSurfaceScroll(surfaceScrollPositions.current, activeSurface.value, mainStageRef.current);
  }, [activeSurface.value]);
  if (officeAccess.value.state !== "authenticated") return <DeviceLogin />;
  const connection = officeConnection.value;
  const connectionLabel = connection.state === "connected"
    ? (connection.eventStream === "open" ? t("connection.live") : t("connection.connected"))
    : connection.state === "demo" ? t("connection.demo")
      : connection.state === "degraded" ? t("connection.degraded")
      : connection.state === "error" ? t("connection.error") : connection.state;
  return (
    <div
      class={`app-shell ${openSessionIds.value.length > 0 ? "has-open-workspace" : "is-workspace-empty"}`}
      style={{ "--sidebar-width": `${sidebarWidth.value}px` }}
    >
      <header class="topbar" data-mobile-route-chrome>
        <a class="brand" href="#" aria-label={t("app.home")} onClick={(event) => { event.preventDefault(); navigateToSurface("office"); }}>
          <span class="brand-mark">H</span>
          <span><b>Hermes</b><small>Studio</small></span>
        </a>
        <div class={`runtime-status runtime-${connection.state}`} title={localizeRuntimeMessage(connection.message)}>
          <i /><span class="rt-label">Studio Server</span> <span class="rt-state">{connectionLabel}</span>
        </div>
        <div class="top-actions">
          <AppearanceSettings />
          <button
            class="quiet-button language-button"
            type="button"
            aria-label={t("language.label")}
            title={t("language.label")}
            onClick={() => setLocale(locale.value === "ja" ? "en" : "ja")}
          >
            {locale.value === "ja" ? "EN" : "日本語"}
          </button>
          <ProfileCommand />
          <button
            class="quiet-button compact-inspector-button"
            type="button"
            aria-label={t("profile.details")}
            title={t("profile.detailsHint")}
            onClick={openMobileInspector}
          >
            ◧
          </button>
        </div>
      </header>

      <SideRail navItems={navItems.filter((item) => item.id !== "office" || officeWindowOpen.value)} />

      <WorkspaceLayout
        hasChats={openSessionIds.value.length > 0}
        surfaceVisible={officeWindowOpen.value || activeSurface.value !== "office"}
        main={(
          <main
            ref={mainStageRef}
            class="main-stage"
            onScroll={(event) => rememberSurfaceScroll(surfaceScrollPositions.current, activeSurface.value, event.currentTarget)}
          >
            {connection.state === "error" && (
              <div class="runtime-error-banner" role="alert">
                <span>{localizeRuntimeMessage(connection.message)}</span>
                <button type="button" onClick={retryOfficeServer}>{t("connection.retry")}</button>
              </div>
            )}
            {activeSurface.value === "office" && officeWindowOpen.value && <OfficeScene profiles={profileList.value} />}
            {activeSurface.value === "kanban" && <KanbanBoard />}
            {activeSurface.value === "teams" && <TeamsPanel />}
            {(activeSurface.value === "settings" || activeSurface.value === "library") && (
              // Host admin is host-scoped and intentionally survives profile selection; "open live settings" switches to the profile tab.
              settingsTab.value === "host" ? (
                <LiveSettings
                  key="settings-host"
                  profileId={null}
                  initialTab="host"
                  activeTab="host"
                  showAccessAudit
                  showHostAdmin
                  onTabChange={setSettingsTab}
                />
              ) : (
                <LiveSettings
                  key={`settings-${selectedProfile.value?.id ?? "global"}`}
                  profileId={selectedProfile.value?.id ?? null}
                  {...(selectedProfile.value?.name === undefined ? {} : { profileLabel: profileDisplayName(selectedProfile.value) })}
                  initialTab={selectedProfile.value ? settingsTab.value : "global"}
                  activeTab={selectedProfile.value ? settingsTab.value : "global"}
                  showAccessAudit
                  showHostAdmin
                  onTabChange={setSettingsTab}
                />
              )
            )}
          </main>
        )}
        workspace={<div class={`workspace-drawer ${openSessionIds.value.length === 0 ? "is-empty" : ""} ${mobileWorkspaceOpen.value ? "is-mobile-open" : ""}`}><ChatWorkspace /></div>}
      />
      <ProfilePanel />
      <ProfileDetailModal />
      <ProfileSettingsModal />
      <ProfileChatModal />
      <RecurringJobsPanel />
    </div>
  );
}

function setSettingsTab(tab: SettingsTab): void {
  settingsTab.value = tab;
  persistUiNavPreferences({
    surface: activeSurface.value,
    settingsTab: tab,
    selectedProfileId: selectedProfile.value?.id ?? "",
  });
}
