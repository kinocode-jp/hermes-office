import { computed, signal } from "@preact/signals";
import type { ChatPromptResult, ChatSteerResult, ChatTarget } from "./chat-api";
import type {
  ApprovalChoice,
  ChatConnectionState,
  ChatSession,
  InspectorTab,
  OfficeAccess,
  OfficeConnection,
  OfficeSnapshot,
  OfficeSnapshotRequestIdentity,
  Profile,
  SettingsTab,
  Surface,
} from "./domain";
import { officeMessage, type RuntimeMessage } from "./i18n";

import {
  restoredActiveSurface,
  restoredSelectedProfileId,
  restoredSettingsTab,
} from "./ui-nav-prefs";

export const profileList = signal<Profile[]>([]);
export const sessions = signal<ChatSession[]>([]);
export const activeSurface = signal<Surface>(restoredActiveSurface);
export const inspectorTab = signal<InspectorTab>("chat");
export const settingsTab = signal<SettingsTab>(restoredSettingsTab);
export const selectedProfileId = signal(restoredSelectedProfileId);
export const openSessionIds = signal<string[]>([]);
export const activeSessionId = signal("");
export const mobileInspectorOpen = signal(false);
export const mobileWorkspaceOpen = signal(false);
export const profileSettingsModalId = signal<string | null>(null);
export const profileDetailModalId = signal<string | null>(null);
export const profileChatModalId = signal<string | null>(null);
export const recurringJobsOpen = signal(false);
export const MAX_OPEN_CHAT_SESSIONS = 4;
export const chatSocketState = signal<{ state: ChatConnectionState; message: RuntimeMessage }>({
  state: "disconnected",
  message: officeMessage("runtime.chat.waiting")
});
export const officeSnapshot = signal<OfficeSnapshot | undefined>(undefined);
export const officeAccess = signal<OfficeAccess>({
  state: "checking",
  serverUrl: "",
  message: officeMessage("runtime.office.checking")
});
export const officeConnection = signal<OfficeConnection>({
  state: "connecting",
  source: "server",
  serverUrl: "",
  eventStream: "closed",
  message: officeMessage("runtime.office.checking")
});
export const selectedProfile = computed(() =>
  profileList.value.find((profile) => profile.id === selectedProfileId.value)
);
export const selectedProfileSessions = computed(() =>
  sessions.value.filter((session) => session.profileId === selectedProfileId.value)
);

export const officeRuntimeHooks = {
  retryOfficeConnection: () => {},
  ensureChatSession: (_target: ChatTarget) => {},
  releaseChatSession: (_clientSessionId: string) => {},
  submitChatPrompt: (async () => ({ status: "rejected", message: "Chat runtime is not registered." })) as (
    clientSessionId: string, text: string, operationId: string
  ) => Promise<ChatPromptResult> | void,
  steerChatSession: (async () => { throw new Error("Chat runtime is not registered."); }) as (
    clientSessionId: string, text: string
  ) => Promise<ChatSteerResult>,
  interruptChatSession: ((_clientSessionId: string) => {}) as (clientSessionId: string) => Promise<void> | void,
  respondClarify: async (_clientSessionId: string, _requestId: string, _answer: string) => {},
  respondApproval: async (_clientSessionId: string, _approvalId: string, _choice: ApprovalChoice) => {},
};

export let runtimeDataSource: "none" | "demo" | "live" = "none";
export let latestOfficeSnapshotIdentity: OfficeSnapshotRequestIdentity | undefined;

export function setRuntimeDataSource(value: "none" | "demo" | "live"): void {
  runtimeDataSource = value;
}
export function setLatestOfficeSnapshotIdentity(value: OfficeSnapshotRequestIdentity | undefined): void {
  latestOfficeSnapshotIdentity = value;
}
