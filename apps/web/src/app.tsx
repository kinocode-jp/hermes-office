import { ChatWorkspace } from "./components/chat-workspace";
import { KanbanBoard } from "./components/kanban-board";
import { LiveSettings } from "./components/live-settings";
import { OfficeScene } from "./components/office-scene";
import { ProfilePanel } from "./components/profile-panel";
import { DeviceLogin } from "./components/device-login";
import { isLocalOfficeClient } from "./auth-state";
import { logoutRemoteDevice } from "./office-api";
import type { Surface } from "./domain";
import { activeSurface, mobileWorkspaceOpen, officeAccess, officeConnection, profileList, selectedProfile, settingsTab } from "./store";

const navItems: { id: Surface; glyph: string; label: string }[] = [
  { id: "office", glyph: "⌂", label: "Office" },
  { id: "kanban", glyph: "▦", label: "Kanban" },
  { id: "library", glyph: "▤", label: "Library" },
  { id: "settings", glyph: "⚙", label: "Settings" }
];

export function App() {
  if (officeAccess.value.state !== "authenticated") return <DeviceLogin />;
  const connection = officeConnection.value;
  const connectionLabel = connection.state === "connected"
    ? (connection.eventStream === "open" ? "live" : "connected")
    : connection.state === "error" ? "demo fallback" : connection.state;
  return (
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="#" aria-label="Hermes Office home">
          <span class="brand-mark">H</span>
          <span><b>Hermes</b><small>Office</small></span>
        </a>
        <div class={`runtime-status runtime-${connection.state}`} title={connection.message}>
          <i />Office Server <span>{connectionLabel}</span>
        </div>
        <div class="top-actions">
          <button class="quiet-button">⌘ K</button>
          {isLocalOfficeClient(location)
            ? <button class="user-button" title="Local owner">KO</button>
            : <button class="user-button" type="button" aria-label="リモート端末からログアウト" onClick={() => void logoutRemoteDevice().then(() => location.reload())}>⇥</button>}
        </div>
      </header>

      <nav class="side-rail" aria-label="メインナビゲーション">
        {navItems.map((item) => (
          <button
            key={item.id}
            class={activeSurface.value === item.id ? "is-active" : ""}
            onClick={() => { activeSurface.value = item.id; }}
          >
            <span>{item.glyph}</span>{item.label}
          </button>
        ))}
      </nav>

      <main class="main-stage">
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
      <div class={`workspace-drawer ${mobileWorkspaceOpen.value ? "is-mobile-open" : ""}`}><ChatWorkspace /></div>
    </div>
  );
}
