import { ChatWorkspace } from "./components/chat-workspace";
import { KanbanBoard } from "./components/kanban-board";
import { LiveSettings } from "./components/live-settings";
import { OfficeScene } from "./components/office-scene";
import { ProfilePanel } from "./components/profile-panel";
import { DeviceLogin } from "./components/device-login";
import { AppearanceSettings } from "./components/appearance-settings";
import { ProfileCommand } from "./components/profile-command";
import { WorkspaceLayout } from "./components/workspace-layout";
import { isLocalOfficeClient } from "./auth-state";
import { logoutRemoteDevice } from "./office-api";
import { locale, localizeRuntimeMessage, setLocale, t, type TranslationKey } from "./i18n";
import type { Surface } from "./domain";
import { surfaceAriaCurrent } from "./navigation-state";
import { activeSurface, mobileInspectorOpen, mobileWorkspaceOpen, navigateToSurface, officeAccess, officeConnection, openSessionIds, profileList, retryOfficeServer, selectedProfile, settingsTab } from "./store";
import { rememberSurfaceScroll, restoreSurfaceScroll, type SurfaceScrollPosition } from "./surface-scroll";
import { useLayoutEffect, useRef } from "preact/hooks";

const navItems: { id: Surface; glyph: string; label: TranslationKey }[] = [
  { id: "office", glyph: "⌂", label: "nav.office" },
  { id: "kanban", glyph: "▦", label: "nav.kanban" },
  { id: "library", glyph: "▤", label: "nav.library" },
  { id: "settings", glyph: "⚙", label: "nav.settings" }
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
    <div class={`app-shell ${openSessionIds.value.length > 0 ? "has-open-workspace" : "is-workspace-empty"}`}>
      <header class="topbar" data-mobile-route-chrome>
        <a class="brand" href="#" aria-label={t("app.home")} onClick={(event) => { event.preventDefault(); navigateToSurface("office"); }}>
          <span class="brand-mark">H</span>
          <span><b>Hermes</b><small>Office</small></span>
        </a>
        <div class={`runtime-status runtime-${connection.state}`} title={localizeRuntimeMessage(connection.message)}>
          <i /><span class="rt-label">Office Server</span> <span class="rt-state">{connectionLabel}</span>
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
            onClick={() => { mobileInspectorOpen.value = true; mobileWorkspaceOpen.value = false; }}
          >
            ◧
          </button>
          {isLocalOfficeClient(location)
            ? <span class="user-button user-button--display" role="note" aria-label={t("app.localOwner")} title={t("app.localOwner")}>KO</span>
            : <button class="user-button" type="button" aria-label={t("app.logout")} onClick={() => void logoutRemoteDevice().then(() => location.reload())}>⇥</button>}
        </div>
      </header>

      <nav class="side-rail" aria-label={t("nav.main")} data-mobile-route-chrome>
        {navItems.map((item) => (
          <button
            key={item.id}
            class={activeSurface.value === item.id ? "is-active" : ""}
            aria-current={surfaceAriaCurrent(activeSurface.value, item.id)}
            onClick={() => navigateToSurface(item.id)}
          >
            <span>{item.glyph}</span>{t(item.label)}
          </button>
        ))}
      </nav>

      <WorkspaceLayout
        hasChats={openSessionIds.value.length > 0}
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
            {activeSurface.value === "office" && <OfficeScene profiles={profileList.value} />}
            {activeSurface.value === "kanban" && <KanbanBoard />}
            {activeSurface.value === "library" && <LiveSettings key="global-library" profileId={null} initialTab="global" />}
            {activeSurface.value === "settings" && (
              // Host admin is host-scoped and intentionally survives profile selection; "open live settings" switches to the profile tab.
              settingsTab.value === "host" ? (
                <LiveSettings
                  key="settings-host"
                  profileId={null}
                  initialTab="host"
                  activeTab="host"
                  showAccessAudit
                  showHostAdmin
                  onTabChange={(tab) => { settingsTab.value = tab; }}
                />
              ) : (
                <LiveSettings
                  key={`settings-${selectedProfile.value?.id ?? "global"}`}
                  profileId={selectedProfile.value?.id ?? null}
                  {...(selectedProfile.value?.name === undefined ? {} : { profileLabel: selectedProfile.value.name })}
                  initialTab={selectedProfile.value ? settingsTab.value : "global"}
                  activeTab={selectedProfile.value ? settingsTab.value : "global"}
                  showAccessAudit
                  showHostAdmin
                  onTabChange={(tab) => { settingsTab.value = tab; }}
                />
              )
            )}
          </main>
        )}
        workspace={<div class={`workspace-drawer ${openSessionIds.value.length === 0 ? "is-empty" : ""} ${mobileWorkspaceOpen.value ? "is-mobile-open" : ""}`}><ChatWorkspace /></div>}
      />
      <ProfilePanel />
    </div>
  );
}
