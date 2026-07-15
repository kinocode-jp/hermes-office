export type ProfileStatus = "working" | "waiting" | "idle" | "blocked";

export type Profile = {
  id: string;
  name: string;
  role: string;
  status: ProfileStatus;
  color: string;
  sessions: number;
  taskCount: number;
  memoryBytes: number;
  memoryNote: string;
  skills: string[];
  inheritedSkills: string[];
};

export type ChatMessage = {
  id: string;
  from: "user" | "agent" | "tool";
  body: string;
  at: string;
};

export type ChatSession = {
  id: string;
  profileId: string;
  title: string;
  status: "streaming" | "ready" | "waiting";
  messages: ChatMessage[];
};

export type TaskStatus = "triage" | "ready" | "running" | "blocked" | "done";

export type WorkTask = {
  id: string;
  title: string;
  status: TaskStatus;
  assigneeId?: string;
  priority: "normal" | "high";
  comments: number;
};

export type Surface = "office" | "kanban" | "library" | "settings";
export type InspectorTab = "chat" | "profile" | "skills" | "memory";

export type GlobalSettings = {
  skills: string[];
  context: string;
  remoteAccess: "off" | "tailscale" | "public";
};
