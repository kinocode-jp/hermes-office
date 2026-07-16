import { ChatWorkspace } from "./components/chat-workspace";
import { KanbanBoard } from "./components/kanban-board";
import { LiveSettings } from "./components/live-settings";
import { OfficeScene } from "./components/office-scene";
import { ProfilePanel } from "./components/profile-panel";
import { DeviceLogin } from "./components/device-login";
import { AppearanceSettings } from "./components/appearance-settings";
import { ProfileCommand } from "./components/profile-command";
import { isLocalOfficeClient } from "./auth-state";
import { logoutRemoteDevice } from "./office-api";
import { locale, localizeRuntimeMessage, setLocale, t, type TranslationKey } from "./i18n";
import type { Surface } from "./domain";
import { activeSurface, mobileInspectorOpen, mobileWorkspaceOpen, officeAccess, officeConnection, openSessionIds, profileList, retryOfficeServer, selectedProfile, settingsTab } from "./store";

const navItems: { id: Surface; glyph: string; label: TranslationKey }[] = [
  { id: "office", glyph: "⌂", label: "nav.office" },
  { id: "kanban", glyph: "▦", label: "nav.kanban" },
  { id: "library", glyph: "▤", label: "nav.library" },
  { id: "settings", glyph: "⚙", label: "nav.settings" }
];

export function App() {
  if (officeAccess.value.state !== "authenticated") return <DeviceLogin />;
  const connection = officeConnection.value;
  const connectionLabel = connection.state === "connected"
    ? (connection.eventStream === "open" ? t("connection.live") : t("connection.connected"))
    : connection.state === "demo" ? t("connection.demo")
      : connection.state === "error" ? t("connection.error") : connection.state;
  return (
    <div class={`app-shell ${openSessionIds.value.length > 0 ? "has-open-workspace" : "is-workspace-empty"}`}>
      <header class="topbar">
        <a class="brand" href="#" aria-label={t("app.home")}>
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
            onClick={() => { mobileInspectorOpen.value = true; }}
          >
            ◧
          </button>
          {isLocalOfficeClient(location)
            ? <button class="user-button" title={t("app.localOwner")}>KO</button>
            : <button class="user-button" type="button" aria-label={t("app.logout")} onClick={() => void logoutRemoteDevice().then(() => location.reload())}>⇥</button>}
        </div>
      </header>

      <nav class="side-rail" aria-label={t("nav.main")}>
        {navItems.map((item) => (
          <button
            key={item.id}
            class={activeSurface.value === item.id ? "is-active" : ""}
            onClick={() => { activeSurface.value = item.id; }}
          >
            <span>{item.glyph}</span>{t(item.label)}
          </button>
        ))}
      </nav>

      <main class="main-stage">
        {connection.state === "error" && (
          <div class="runtime-error-banner" role="alert">
            <span>{localizeRuntimeMessage(connection.message)}</span>
            <button type="button" onClick={retryOfficeServer}>{t("connection.retry")}</button>
          </div>
        )}
        {activeSurface.value === "office" && <OfficeScene profiles={profileList.value} />}
        {activeSurface.value === "kanban" && <KanbanBoard />}
        {activeSurface.value === "library" && <LiveSettings key="global-library" profileId={null} initialTab="global" />}
        {activeSurface.value === "settings" && <LiveSettings
          key={`settings-${selectedProfile.value?.id ?? "global"}`}
          profileId={selectedProfile.value?.id ?? null}
          {...(selectedProfile.value?.name === undefined ? {} : { profileLabel: selectedProfile.value.name })}
          initialTab={selectedProfile.value ? settingsTab.value : "global"}
          activeTab={selectedProfile.value ? settingsTab.value : "global"}
          showAccessAudit
          onTabChange={(tab) => { settingsTab.value = tab; }}
        />}
      </main>

      <ProfilePanel />
      <div class={`workspace-drawer ${openSessionIds.value.length === 0 ? "is-empty" : ""} ${mobileWorkspaceOpen.value ? "is-mobile-open" : ""}`}><ChatWorkspace /></div>
    </div>
  );
}
