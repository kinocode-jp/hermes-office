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
  readOnly?: boolean;
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

export type OfficeConnectionState = "demo" | "connecting" | "connected" | "error";

export type OfficeRuntimeState =
  | "unconfigured"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "unreachable"
  | "incompatible"
  | "error";

export type OfficeConnection = {
  state: OfficeConnectionState;
  source: "demo" | "server";
  serverUrl: string;
  runtime?: OfficeRuntimeState;
  protocolVersion?: number;
  generatedAt?: string;
  eventStream: "closed" | "connecting" | "open";
  message: string;
};

export type OfficeSnapshotProfile = {
  id: string;
  name: string;
  activity: string;
  activeSessionCount: number;
};

export type OfficeSnapshot = {
  generatedAt: string;
  sequence: number;
  capabilities: {
    protocolVersion: number;
    serverVersion: string;
    runtime: { state: OfficeRuntimeState; hermesVersion?: string };
  };
  profiles: OfficeSnapshotProfile[];
  sessions: Array<{ id: string; profileId: string; title: string; activity: string }>;
  boards: Array<{ id: string; name: string; cardCount: number }>;
};
