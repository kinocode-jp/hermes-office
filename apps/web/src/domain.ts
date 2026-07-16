import type { Operation } from "@hermes-office/protocol";

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
  status?: "streaming" | "complete" | "failed" | "cancelled";
};

export type ChatConnectionState = "disconnected" | "connecting" | "ready" | "error";
export type ChatHistoryState = "unloaded" | "loading" | "loaded" | "error";

export type ApprovalChoice = "once" | "session" | "always" | "deny";

export type ChatPendingInteraction =
  | {
      id: string;
      kind: "clarify";
      requestId: string;
      question: string;
      choices: string[];
      submitting: boolean;
      error?: string | undefined;
    }
  | {
      id: string;
      kind: "approval";
      approvalId: string;
      command?: string | undefined;
      description?: string | undefined;
      choices: ApprovalChoice[];
      allowPermanent: boolean;
      submitting: boolean;
      error?: string | undefined;
    };

export type ChatSession = {
  /** Stable UI identity. It can exist before Hermes persists a session. */
  id: string;
  /** Durable Hermes state.db identity used by REST history and resume. */
  storedSessionId?: string | undefined;
  /** Process-local gateway identity, valid only for the current WebSocket. */
  liveSessionId?: string | undefined;
  profileId: string;
  title: string;
  status: "streaming" | "ready" | "waiting";
  messages: ChatMessage[];
  connectionState?: ChatConnectionState;
  historyState?: ChatHistoryState;
  historyPartial?: boolean;
  historyNotice?: string | undefined;
  errorMessage?: string | undefined;
  remoteKind?: "demo" | "stored" | "draft" | undefined;
  streamingMessageId?: string | undefined;
  pendingInteraction?: ChatPendingInteraction | undefined;
  readOnly?: boolean;
};

export type TaskStatus = "triage" | "todo" | "scheduled" | "ready" | "running" | "blocked" | "review" | "done" | "archived";
export type TaskWritableStatus = "triage" | "todo" | "scheduled" | "ready" | "blocked" | "done" | "archived";

export type WorkTask = {
  id: string;
  title: string;
  body?: string | undefined;
  status: TaskStatus;
  assigneeId?: string | undefined;
  priority: "normal" | "high";
  priorityValue?: number;
  comments: number;
  latestSummary?: string | undefined;
  pending?: boolean;
};

export type KanbanConnectionState = "idle" | "loading" | "ready" | "saving" | "error";

export type Surface = "office" | "kanban" | "library" | "settings";
export type InspectorTab = "chat" | "profile" | "skills" | "memory";
export type SettingsTab = "global" | "skills" | "soul" | "memory";

export type OfficeConnectionState = "demo" | "connecting" | "connected" | "error";
export type OfficeAccessState = "checking" | "login-required" | "submitting" | "authenticated" | "unavailable";

export type OfficeAccess = {
  state: OfficeAccessState;
  serverUrl: string;
  message: string;
  failureCode?: "invalid" | "rate-limited" | "disabled" | "unavailable" | undefined;
  retryAfterSeconds?: number | undefined;
};

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

export type OfficeInventoryPagination = {
  returned: number;
  available: number;
  total?: number;
  hasMore: boolean;
  truncated: boolean;
  partialFailures: number;
  nextCursor?: string;
};

export type OfficeSnapshot = {
  generatedAt: string;
  sequence: number;
  capabilities: {
    protocolVersion: number;
    serverVersion: string;
    runtime: { state: OfficeRuntimeState; hermesVersion?: string; adapterVersion?: string };
    access: {
      deviceId: string;
      tier: "viewer" | "operator" | "manager" | "owner";
      exposure: "loopback" | "tailnet" | "public";
      authentication: "desktop-capability" | "local-cookie" | "device-cookie" | "tailscale-identity" | "oidc";
      allowedOperations: Operation[];
    };
    features: Array<"chat" | "profiles" | "skills" | "memory" | "kanban" | "global-inheritance" | "demo">;
  };
  profiles: OfficeSnapshotProfile[];
  sessions: Array<{ id: string; profileId: string; title: string; activity: string }>;
  inventory: { profiles: OfficeInventoryPagination; sessions: OfficeInventoryPagination };
  boards: Array<{ id: string; name: string; cardCount: number }>;
};
