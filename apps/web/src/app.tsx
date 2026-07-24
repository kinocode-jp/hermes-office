import { ChatWorkspace } from "./components/chat-workspace";
import { KanbanBoard } from "./components/kanban-board";
import { OfficeScene } from "./components/office-scene";
import { TeamsPanel } from "./components/teams-panel";
import { DeviceLogin } from "./components/device-login";
import { AppearanceSettings } from "./components/appearance-settings";
import { ProfileCommand } from "./components/profile-command";
import { ProfileSettingsModal } from "./components/profile-settings-modal";
import { SettingsModal } from "./components/settings-modal";
import { ProfileChatModal } from "./components/profile-chat-modal";
import { ScheduledSessionsPanel } from "./components/scheduled-sessions-panel";
import { SideRail, type SideRailNavItem } from "./components/side-rail";
import { WorkspaceLayout } from "./components/workspace-layout";
import { locale, localizeRuntimeMessage, setLocale, t, type TranslationKey } from "./i18n";
import { BoardIcon, HomeIcon, SettingsIcon, UsersIcon } from "./components/icons";
import type { Surface } from "./domain";
import { officeWindowOpen } from "./office-window";
import { sidebarWidth } from "./sidebar-layout";
import { activeSurface, mobileWorkspaceOpen, navigateToSurface, officeAccess, officeConnection, openSessionIds, closeSettingsModal, openSettingsModal, profileList, retryOfficeServer, selectedProfile, settingsModalOpen, settingsTab, workspaceSessionDropPreview } from "./store";
import { rememberSurfaceScroll, restoreSurfaceScroll, type SurfaceScrollPosition } from "./surface-scroll";
import { useLayoutEffect, useRef } from "preact/hooks";

const navItems: { id: Surface; icon: SideRailNavItem["icon"]; label: TranslationKey }[] = [
  { id: "office", icon: HomeIcon, label: "nav.office" },
  { id: "kanban", icon: BoardIcon, label: "nav.kanban" },
  { id: "teams", icon: UsersIcon, label: "nav.teams" },
];

export function App() {
  const mainStageRef = useRef<HTMLElement>(null);
  const surfaceScrollPositions = useRef(new Map<Surface, SurfaceScrollPosition>());
  useLayoutEffect(() => {
    if (mainStageRef.current) restoreSurfaceScroll(surfaceScrollPositions.current, activeSurface.value, mainStageRef.current);
  }, [activeSurface.value]);
  if (officeAccess.value.state !== "authenticated") return <DeviceLogin />;
  const hasChats = openSessionIds.value.length > 0 || workspaceSessionDropPreview.value;
  const connection = officeConnection.value;
  const connectionLabel = connection.state === "connected"
    ? (connection.eventStream === "open" ? t("connection.live") : t("connection.connected"))
    : connection.state === "demo" ? t("connection.demo")
      : connection.state === "degraded" ? t("connection.degraded")
      : connection.state === "error" ? t("connection.error") : connection.state;
  return (
    <div
      class={`app-shell ${hasChats ? "has-open-workspace" : "is-workspace-empty"} ${workspaceSessionDropPreview.value ? "is-session-drop-preview" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth.value}px` }}
    >
      <header class="topbar" data-mobile-route-chrome>
        <a class="brand" href="#" aria-label={t("app.home")} title={t("app.home")} onClick={(event) => { event.preventDefault(); navigateToSurface("office"); }}>
          <span class="brand-mark" aria-hidden="true">H</span>
        </a>
        <div
          class={`runtime-status runtime-${connection.state}`}
          role="status"
          aria-label={`${connectionLabel}: ${localizeRuntimeMessage(connection.message)}`}
          title={`${connectionLabel} — ${localizeRuntimeMessage(connection.message)}`}
        >
          <i aria-hidden="true" />
        </div>
        <div class="top-actions">
          <AppearanceSettings />
          <button
            class={`icon-button settings-header-button ${settingsModalOpen.value ? "is-active" : ""}`}
            type="button"
            aria-label={t("nav.settings")}
            title={t("nav.settings")}
            aria-pressed={settingsModalOpen.value}
            onClick={() => {
              if (settingsModalOpen.value) closeSettingsModal();
              else openSettingsModal(settingsTab.value);
            }}
          >
            <SettingsIcon />
          </button>
          <button
            class="quiet-button language-button"
            type="button"
            aria-label={t("language.label")}
            title={t("language.label")}
            onClick={() => setLocale(locale.value === "ja" ? "en" : "ja")}
          >
            <span aria-hidden="true">{locale.value === "ja" ? "A" : "文"}</span>
          </button>
          <ProfileCommand />
        </div>
      </header>

      <SideRail navItems={navItems.filter((item) => item.id !== "office" || officeWindowOpen.value)} />

      <WorkspaceLayout
        hasChats={hasChats}
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
            {activeSurface.value === "scheduled" && <ScheduledSessionsPanel />}
          </main>
        )}
        workspace={<div class={`workspace-drawer ${openSessionIds.value.length === 0 ? "is-empty" : ""} ${mobileWorkspaceOpen.value ? "is-mobile-open" : ""} ${workspaceSessionDropPreview.value ? "is-drop-preview" : ""}`}><ChatWorkspace /></div>}
      />
      <ProfileSettingsModal />
      <SettingsModal />
      <ProfileChatModal />
    </div>
  );
}

