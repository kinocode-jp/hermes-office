import type { InspectorTab } from "../domain";
import { useState } from "preact/hooks";
import {
  addProfileSkill,
  createSession,
  inspectorTab,
  mobileInspectorOpen,
  mobileWorkspaceOpen,
  openSession,
  removeProfileSkill,
  selectedProfile,
  selectedProfileSessions,
  updateProfile
} from "../store";
import { StatusPill } from "./status-pill";

const tabs: { id: InspectorTab; label: string }[] = [
  { id: "chat", label: "会話" },
  { id: "profile", label: "Profile" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" }
];

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

function ProfileSettings() {
  const profile = selectedProfile.value;
  if (!profile) return null;
  return (
    <div class="panel-section form-stack">
      <label>表示名<input value={profile.name} onInput={(event) => updateProfile(profile.id, { name: event.currentTarget.value })} /></label>
      <label>役割<input value={profile.role} onInput={(event) => updateProfile(profile.id, { role: event.currentTarget.value })} /></label>
      <label>既定モデル<select><option>Profile default</option><option>Hermes 4</option></select></label>
      <label class="toggle-row"><span>Kanban worker</span><input type="checkbox" checked /></label>
      <p class="setting-note">実接続後はHermesのProfile設定へ安全に書き戻します。</p>
    </div>
  );
}

function SkillSettings() {
  const profile = selectedProfile.value;
  const [skill, setSkill] = useState("");
  if (!profile) return null;
  return (
    <div class="panel-section">
      <div class="inheritance-title"><b>Profile skills</b><span>{profile.skills.length}</span></div>
      <div class="tag-list editable">{profile.skills.map((item) => <button key={item} onClick={() => removeProfileSkill(profile.id, item)} title="クリックして削除">{item}<i>×</i></button>)}</div>
      <form class="inline-add compact" onSubmit={(event) => { event.preventDefault(); addProfileSkill(profile.id, skill); setSkill(""); }}>
        <input value={skill} onInput={(event) => setSkill(event.currentTarget.value)} placeholder="skill-name" aria-label="Profile Skill名" />
        <button type="submit">追加</button>
      </form>
      <div class="inheritance-title"><b>Company library</b><span>{profile.inheritedSkills.length}</span></div>
      <div class="tag-list inherited">{profile.inheritedSkills.map((skill) => <span key={skill}>{skill}<i>global</i></span>)}</div>
    </div>
  );
}

function MemorySettings() {
  const profile = selectedProfile.value;
  if (!profile) return null;
  const percentage = Math.round((profile.memoryBytes / 2200) * 100);
  return (
    <div class="panel-section">
      <div class="memory-meter"><span style={{ width: `${percentage}%` }} /></div>
      <div class="memory-readout"><b>{profile.memoryBytes.toLocaleString()} / 2,200</b><span>profile memory</span></div>
      <div class="memory-card global-memory">
        <span>GLOBAL CONTEXT</span>
        <p>全Profileに読み取り専用で共有する会社方針と利用者情報。</p>
      </div>
      <div class="memory-card">
        <span>PROFILE MEMORY</span>
        <textarea value={profile.memoryNote} onInput={(event) => updateProfile(profile.id, { memoryNote: event.currentTarget.value })} rows={6} aria-label={`${profile.name}のMemory`} />
      </div>
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
          <button class={inspectorTab.value === tab.id ? "is-active" : ""} onClick={() => { inspectorTab.value = tab.id; }} key={tab.id}>
            {tab.label}
          </button>
        ))}
      </nav>
      {inspectorTab.value === "chat" && <ChatList />}
      {inspectorTab.value === "profile" && <ProfileSettings />}
      {inspectorTab.value === "skills" && <SkillSettings />}
      {inspectorTab.value === "memory" && <MemorySettings />}
    </aside>
  );
}
