import { computed, signal } from "@preact/signals";
import { initialSessions, initialTasks, profiles } from "./demo-data";
import type { ChatSession, GlobalSettings, InspectorTab, Profile, Surface, TaskStatus, WorkTask } from "./domain";

export const profileList = signal(profiles);
export const sessions = signal<ChatSession[]>(initialSessions);
export const tasks = signal<WorkTask[]>(initialTasks);
export const activeSurface = signal<Surface>("office");
export const inspectorTab = signal<InspectorTab>("chat");
export const selectedProfileId = signal(profiles[0]?.id ?? "");
export const openSessionIds = signal<string[]>(["s-research-1", "s-build-1"]);
export const activeSessionId = signal("s-research-1");
export const mobileInspectorOpen = signal(false);
export const mobileWorkspaceOpen = signal(false);
export const globalSettings = signal<GlobalSettings>({
  skills: ["web-search", "document-reader", "git", "kanban"],
  context: "安全性を優先し、外部への送信や破壊的操作は利用者の確認後に実行する。",
  remoteAccess: "off"
});

export const selectedProfile = computed(() =>
  profileList.value.find((profile) => profile.id === selectedProfileId.value)
);

export const selectedProfileSessions = computed(() =>
  sessions.value.filter((session) => session.profileId === selectedProfileId.value)
);

export function selectProfile(profileId: string): void {
  selectedProfileId.value = profileId;
  const firstSession = sessions.value.find((session) => session.profileId === profileId);
  if (firstSession) {
    openSession(firstSession.id);
    mobileWorkspaceOpen.value = true;
    mobileInspectorOpen.value = false;
  } else {
    mobileInspectorOpen.value = true;
  }
  inspectorTab.value = "chat";
}

export function openSession(sessionId: string): void {
  if (!openSessionIds.value.includes(sessionId)) {
    openSessionIds.value = [...openSessionIds.value, sessionId].slice(-4);
  }
  activeSessionId.value = sessionId;
  const session = sessions.value.find((item) => item.id === sessionId);
  if (session) selectedProfileId.value = session.profileId;
}

export function closeSession(sessionId: string): void {
  openSessionIds.value = openSessionIds.value.filter((id) => id !== sessionId);
  if (activeSessionId.value === sessionId) {
    activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  }
  if (openSessionIds.value.length === 0) mobileWorkspaceOpen.value = false;
}

export function createSession(profileId: string): void {
  const session: ChatSession = {
    id: crypto.randomUUID(),
    profileId,
    title: "新しい会話",
    status: "ready",
    messages: []
  };
  sessions.value = [...sessions.value, session];
  openSession(session.id);
}

export function sendMessage(sessionId: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  sessions.value = sessions.value.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          status: "streaming",
          messages: [
            ...session.messages,
            { id: crypto.randomUUID(), from: "user", body: trimmed, at: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) }
          ]
        }
      : session
  );
}

export function assignTask(taskId: string, profileId: string): void {
  tasks.value = tasks.value.map((task) =>
    task.id === taskId ? { ...task, assigneeId: profileId, status: task.status === "triage" ? "ready" : task.status } : task
  );
}

export function moveTask(taskId: string, status: TaskStatus): void {
  tasks.value = tasks.value.map((task) => task.id === taskId ? { ...task, status } : task);
}

export function createTask(title: string): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  const number = Math.max(100, ...tasks.value.map((task) => Number.parseInt(task.id.replace(/^t-/, ""), 10)).filter(Number.isFinite)) + 1;
  tasks.value = [...tasks.value, { id: `t-${number}`, title: trimmed, status: "triage", priority: "normal", comments: 0 }];
}

export function updateProfile(profileId: string, patch: Partial<Pick<Profile, "name" | "role" | "memoryNote">>): void {
  profileList.value = profileList.value.map((profile) => profile.id === profileId ? { ...profile, ...patch } : profile);
}

export function addProfileSkill(profileId: string, skill: string): void {
  const value = skill.trim();
  if (!value) return;
  profileList.value = profileList.value.map((profile) => profile.id === profileId && !profile.skills.includes(value)
    ? { ...profile, skills: [...profile.skills, value] }
    : profile);
}

export function removeProfileSkill(profileId: string, skill: string): void {
  profileList.value = profileList.value.map((profile) => profile.id === profileId
    ? { ...profile, skills: profile.skills.filter((item) => item !== skill) }
    : profile);
}

export function setGlobalSettings(patch: Partial<GlobalSettings>): void {
  globalSettings.value = { ...globalSettings.value, ...patch };
}

export function addGlobalSkill(skill: string): void {
  const value = skill.trim();
  if (!value || globalSettings.value.skills.includes(value)) return;
  setGlobalSettings({ skills: [...globalSettings.value.skills, value] });
}

export function removeGlobalSkill(skill: string): void {
  setGlobalSettings({ skills: globalSettings.value.skills.filter((item) => item !== skill) });
}
