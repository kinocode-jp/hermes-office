import { computed, signal } from "@preact/signals";
import { initialSessions, initialTasks, profiles } from "./demo-data";
import type { ChatSession, GlobalSettings, InspectorTab, OfficeConnection, OfficeSnapshot, Profile, Surface, TaskStatus, WorkTask } from "./domain";

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
export const officeSnapshot = signal<OfficeSnapshot | undefined>(undefined);
export const officeConnection = signal<OfficeConnection>({
  state: "demo",
  source: "demo",
  serverUrl: "",
  eventStream: "closed",
  message: "ローカルデモデータを表示中"
});
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

let retryOfficeConnection = () => {};

export function registerOfficeRetry(action: () => void): void {
  retryOfficeConnection = action;
}

export function retryOfficeServer(): void {
  retryOfficeConnection();
}

export function setOfficeConnecting(serverUrl: string): void {
  officeConnection.value = {
    ...officeConnection.value,
    state: "connecting",
    serverUrl,
    eventStream: "closed",
    message: "Office Serverを確認中"
  };
}

export function applyOfficeSnapshot(snapshot: OfficeSnapshot, serverUrl: string): void {
  officeSnapshot.value = snapshot;
  officeConnection.value = {
    state: "connected",
    source: "server",
    serverUrl,
    runtime: snapshot.capabilities.runtime.state,
    protocolVersion: snapshot.capabilities.protocolVersion,
    generatedAt: snapshot.generatedAt,
    eventStream: officeConnection.value.eventStream,
    message: snapshot.capabilities.runtime.state === "ready" ? "Hermes runtime ready" : `Hermes runtime ${snapshot.capabilities.runtime.state}`
  };

  if (snapshot.capabilities.runtime.state !== "ready" || snapshot.profiles.length === 0) return;

  const previousProfiles = new Map(profileList.value.map((profile) => [profile.id, profile]));
  const sessionCounts = new Map<string, number>();
  for (const session of snapshot.sessions) {
    sessionCounts.set(session.profileId, (sessionCounts.get(session.profileId) ?? 0) + 1);
  }
  const palette = ["#64b7a7", "#e07a55", "#d6a94f", "#8499c8", "#55d6be", "#f06a57"];
  profileList.value = snapshot.profiles.map((live, index) => {
    const previous = previousProfiles.get(live.id);
    return {
      id: live.id,
      name: live.name,
      role: previous?.role ?? "Hermes Profile",
      status: activityToStatus(live.activity),
      color: previous?.color ?? palette[index % palette.length]!,
      sessions: sessionCounts.get(live.id) ?? live.activeSessionCount,
      taskCount: previous?.taskCount ?? 0,
      memoryBytes: previous?.memoryBytes ?? 0,
      memoryNote: previous?.memoryNote ?? "Hermes runtimeから読み取ったProfileです。",
      skills: previous?.skills ?? [],
      inheritedSkills: previous?.inheritedSkills ?? []
    };
  });

  const previousSessions = new Map(sessions.value.map((session) => [session.id, session]));
  sessions.value = snapshot.sessions.map((live) => previousSessions.get(live.id) ?? {
    id: live.id,
    profileId: live.profileId,
    title: live.title,
    status: live.activity === "thinking" || live.activity === "using-tool" ? "streaming" : live.activity === "waiting-for-user" ? "waiting" : "ready",
    messages: [],
    readOnly: true
  });

  const liveSessionIds = new Set(sessions.value.map((session) => session.id));
  openSessionIds.value = openSessionIds.value.filter((id) => liveSessionIds.has(id));
  if (!liveSessionIds.has(activeSessionId.value)) activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  if (!profileList.value.some((profile) => profile.id === selectedProfileId.value)) {
    selectedProfileId.value = profileList.value[0]?.id ?? "";
  }
}

export function setOfficeEventStream(eventStream: OfficeConnection["eventStream"]): void {
  officeConnection.value = { ...officeConnection.value, eventStream };
}

export function setOfficeError(message: string, serverUrl: string): void {
  officeConnection.value = {
    ...officeConnection.value,
    state: "error",
    source: "demo",
    serverUrl,
    eventStream: "closed",
    message
  };
}

function activityToStatus(activity: string): Profile["status"] {
  if (activity === "thinking" || activity === "using-tool") return "working";
  if (activity === "waiting-for-user") return "waiting";
  if (activity === "blocked" || activity === "error") return "blocked";
  return "idle";
}

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
