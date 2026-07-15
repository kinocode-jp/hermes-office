import { ChatWorkspace } from "./components/chat-workspace";
import { LibraryPage, SettingsPage } from "./components/control-pages";
import { KanbanBoard } from "./components/kanban-board";
import { OfficeScene } from "./components/office-scene";
import { ProfilePanel } from "./components/profile-panel";
import type { Surface } from "./domain";
import { activeSurface, mobileWorkspaceOpen, profileList } from "./store";

const navItems: { id: Surface; glyph: string; label: string }[] = [
  { id: "office", glyph: "⌂", label: "Office" },
  { id: "kanban", glyph: "▦", label: "Kanban" },
  { id: "library", glyph: "▤", label: "Library" },
  { id: "settings", glyph: "⚙", label: "Settings" }
];

export function App() {
  return (
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="#" aria-label="Hermes Office home">
          <span class="brand-mark">H</span>
          <span><b>Hermes</b><small>Office</small></span>
        </a>
        <div class="runtime-status"><i />Local office <span>connected</span></div>
        <div class="top-actions">
          <button class="quiet-button">⌘ K</button>
          <button class="user-button">KO</button>
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
        {activeSurface.value === "library" && <LibraryPage />}
        {activeSurface.value === "settings" && <SettingsPage />}
      </main>

      <ProfilePanel />
      <div class={`workspace-drawer ${mobileWorkspaceOpen.value ? "is-mobile-open" : ""}`}><ChatWorkspace /></div>
    </div>
  );
}
