import type { InspectorTab, SettingsTab } from "../domain";
import {
  activeSurface,
  createSession,
  inspectorTab,
  mobileInspectorOpen,
  mobileWorkspaceOpen,
  openSession,
  selectedProfile,
  selectedProfileSessions,
  settingsTab
} from "../store";
import { StatusPill } from "./status-pill";

const tabs: { id: InspectorTab; label: string }[] = [
  { id: "chat", label: "会話" },
  { id: "profile", label: "Identity" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" }
];

const settingsRoutes: Record<Exclude<InspectorTab, "chat">, SettingsTab> = {
  profile: "soul",
  skills: "skills",
  memory: "memory"
};

const routeCopy: Record<Exclude<InspectorTab, "chat">, { code: string; title: string; description: string }> = {
  profile: {
    code: "SOUL / LIVE",
    title: "Identity / SOUL.md",
    description: "このProfileの人格・方針をHermesの実SOUL設定で編集します。変更は新しいSessionから反映されます。"
  },
  skills: {
    code: "SKILLS / LIVE",
    title: "Profile Skills",
    description: "Hermesが検出したSkill一覧を読み込み、Profileごとの有効・無効を実設定へ保存します。"
  },
  memory: {
    code: "MEMORY / LIVE",
    title: "Memory provider",
    description: "Built-in Memoryの使用量とProvider設定をHermesから読み込みます。内容の直接編集やresetは行いません。"
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
  if (!profile) return null;
  return (
    <div class="panel-section">
      <button class="new-chat-button" onClick={() => createSession(profile.id)}>＋ 新しい会話</button>
      <div class="session-list">
        {selectedProfileSessions.value.map((session) => (
          <button key={session.id} onClick={() => { openSession(session.id); mobileInspectorOpen.value = false; mobileWorkspaceOpen.value = true; }}>
            <span>{session.title}</span>
            <small>{session.status === "streaming" ? "実行中" : "開く"}</small>
          </button>
        ))}
      </div>
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
        <h3>{copy.title}</h3>
        <p>{copy.description}</p>
        <dl>
          <div><dt>Target</dt><dd>{profile.name}</dd></div>
          <div><dt>Profile ID</dt><dd>{profile.id}</dd></div>
        </dl>
        <button type="button" onClick={() => openLiveSettings(tab)}>Live設定を開く →</button>
      </article>
      <p class="setting-note">このパネルにはローカルコピーを作りません。表示・保存はすべてHermesの現在値を使用します。</p>
    </div>
  );
}

export function ProfilePanel() {
  const profile = selectedProfile.value;
  if (!profile) return null;
  return (
    <aside class={`profile-panel ${mobileInspectorOpen.value ? "is-mobile-open" : ""}`} aria-label="Profile詳細">
      <header class="profile-panel-head">
        <button class="mobile-close" onClick={() => { mobileInspectorOpen.value = false; }} aria-label="閉じる">←</button>
        <span class="portrait" style={{ "--agent-color": profile.color }}><i /><b /></span>
        <div><h2>{profile.name}</h2><p>{profile.role}</p></div>
        <StatusPill status={profile.status} />
      </header>
      <nav class="panel-tabs" aria-label="Profile設定">
        {tabs.map((tab) => (
          <button
            class={inspectorTab.value === tab.id ? "is-active" : ""}
            onClick={() => {
              if (tab.id === "chat") inspectorTab.value = "chat";
              else openLiveSettings(tab.id);
            }}
            key={tab.id}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {inspectorTab.value === "chat"
        ? <ChatList />
        : <LiveSettingsRoute tab={inspectorTab.value} />}
    </aside>
  );
}
