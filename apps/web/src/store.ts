import { computed, signal } from "@preact/signals";
import { officeInventoryReliability } from "@hermes-office/protocol";
import { initialSessions, initialTaskComments, initialTasks, profiles } from "./demo-data";
import { createDemoKanbanApi } from "./demo-kanban-api";
import type { ChatGatewayEvent, ChatHistoryResult, ChatPromptResult, ChatSteerResult, ChatTarget } from "./chat-api";
import type { ApprovalChoice, ChatConnectionState, ChatMessage, ChatPendingInteraction, ChatSession, InspectorTab, OfficeAccess, OfficeConnection, OfficeSnapshot, OfficeSnapshotRequestIdentity, Profile, SettingsTab, Surface } from "./domain";
import type { DeviceLoginFailure } from "./auth-state";
import { loadKanbanDemoRuntime, registerKanbanProfileTaskUpdater, resetKanbanRuntimeState } from "./kanban-store";
import { findStoredSession, storedSessionClientId } from "./session-identity";
import { canSubmitChatPrompt, isChatRunActive, mergeGatewayStatusUpdate, mergeServerSessionStatus } from "./session-runtime";
import { reconcileChatSessionConnecting, reconcileChatSessionDisconnected, reconcileChatSessionError, reconcileChatSessionReady, type ChatSessionReadyRuntime } from "./chat-session-reconciliation";
import { approvalChoices, gatewayMessageId, nowTimestamp, stringArray, stringValue } from "./chat-store-utils";
import { boundedChatOperationEvidence, interruptChatRun, steerChatRun } from "./chat-run-actions";
import { officeMessage, officeRuntimeMessage, upstreamMessage, type RuntimeMessage } from "./i18n";
export { addTaskComment, assignTask, createTask, expandedTaskId, kanbanAssignees, kanbanState, moveTask, refreshKanbanBoard, registerKanbanRuntime, retryTaskComments, taskCommentDetail, tasks, toggleTaskComments } from "./kanban-store";
export const profileList = signal<Profile[]>([]);
export const sessions = signal<ChatSession[]>([]);
registerKanbanProfileTaskUpdater((counts) => {
  profileList.value = profileList.value.map((profile) => ({ ...profile, taskCount: counts.get(profile.id) ?? 0 }));
});
export const activeSurface = signal<Surface>("office");
export const inspectorTab = signal<InspectorTab>("chat");
export const settingsTab = signal<SettingsTab>("skills");
export const selectedProfileId = signal("");
export const openSessionIds = signal<string[]>([]);
export const activeSessionId = signal("");
export const mobileInspectorOpen = signal(false);
export const mobileWorkspaceOpen = signal(false);
export const MAX_OPEN_CHAT_SESSIONS = 4;

export function navigateToSurface(surface: Surface): void {
  activeSurface.value = surface;
  mobileInspectorOpen.value = false;
  mobileWorkspaceOpen.value = false;
}
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
let retryOfficeConnection = () => {};
let ensureChatSession = (_target: ChatTarget) => {};
let releaseChatSession = (_clientSessionId: string) => {};
let submitChatPrompt: (clientSessionId: string, text: string, operationId: string) => Promise<ChatPromptResult> | void = async () => ({ status: "rejected", message: "Chat runtime is not registered." });
let steerChatSession: (clientSessionId: string, text: string) => Promise<ChatSteerResult> = async () => { throw new Error("Chat runtime is not registered."); };
let interruptChatSession: (clientSessionId: string) => Promise<void> | void = (_clientSessionId: string) => {};
let respondClarify = async (_clientSessionId: string, _requestId: string, _answer: string) => {};
let respondApproval = async (_clientSessionId: string, _approvalId: string, _choice: ApprovalChoice) => {};
let runtimeDataSource: "none" | "demo" | "live" = "none";
let latestOfficeSnapshotIdentity: OfficeSnapshotRequestIdentity | undefined;

export function registerChatRuntime(actions: {
  ensureSession(target: ChatTarget): void;
  releaseSession(clientSessionId: string): void;
  submitPrompt(clientSessionId: string, text: string, operationId: string): Promise<ChatPromptResult> | void;
  steer(clientSessionId: string, text: string): Promise<ChatSteerResult>;
  interrupt(clientSessionId: string): Promise<void> | void;
  respondClarify(clientSessionId: string, requestId: string, answer: string): Promise<void>;
  respondApproval(clientSessionId: string, approvalId: string, choice: ApprovalChoice): Promise<void>;
}): void {
  ensureChatSession = actions.ensureSession;
  releaseChatSession = actions.releaseSession;
  submitChatPrompt = actions.submitPrompt;
  steerChatSession = actions.steer;
  interruptChatSession = actions.interrupt;
  respondClarify = actions.respondClarify;
  respondApproval = actions.respondApproval;
  for (const target of getOpenChatTargets()) ensureChatSession(target);
}
export function getOpenChatTargets(): ChatTarget[] {
  return openSessionIds.value.flatMap((clientSessionId) => {
    const session = sessions.value.find((item) => item.id === clientSessionId);
    if (!session || session.remoteKind === "demo" || !session.remoteKind) return [];
    return [{
      clientSessionId: session.id,
      profileId: session.profileId,
      ...(session.storedSessionId ? { storedSessionId: session.storedSessionId } : {})
    }];
  });
}

export function registerOfficeRetry(action: () => void): void {
  retryOfficeConnection = action;
}

export function retryOfficeServer(): void {
  officeAccess.value = { ...officeAccess.value, state: "checking", message: officeMessage("runtime.office.reconnecting") };
  retryOfficeConnection();
}

export function requireDeviceLogin(serverUrl: string): void {
  officeAccess.value = {
    state: "login-required",
    serverUrl,
    message: officeMessage("runtime.auth.loginRequired")
  };
}

export function setDeviceLoginSubmitting(): void {
  officeAccess.value = { ...officeAccess.value, state: "submitting", message: officeMessage("runtime.auth.authenticating") };
}

export function setDeviceLoginFailure(failure: DeviceLoginFailure): void {
  officeAccess.value = {
    ...officeAccess.value,
    state: failure.code === "unavailable" ? "unavailable" : "login-required",
    message: officeRuntimeMessage(failure.message),
    failureCode: failure.code,
    ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {})
  };
}

export function setOfficeAuthenticated(serverUrl: string): void {
  officeAccess.value = { state: "authenticated", serverUrl, message: officeMessage("runtime.auth.authenticated") };
}

export function setOfficeAccessUnavailable(serverUrl: string, message: string): void {
  officeAccess.value = { state: "unavailable", serverUrl, message: officeRuntimeMessage(message), failureCode: "unavailable" };
}

export function setOfficeConnecting(serverUrl: string): void {
  officeConnection.value = {
    ...officeConnection.value,
    state: "connecting",
    serverUrl,
    eventStream: "closed",
    message: officeMessage("runtime.office.connecting")
  };
}

export function applyOfficeSnapshot(snapshot: OfficeSnapshot, source: string | OfficeSnapshotRequestIdentity): boolean {
  const serverUrl = typeof source === "string" ? source : source.serverUrl;
  if (typeof source !== "string") {
    const latest = latestOfficeSnapshotIdentity;
    if (latest && (source.connectionGeneration < latest.connectionGeneration
      || (source.connectionGeneration === latest.connectionGeneration && source.requestGeneration <= latest.requestGeneration))) return false;
    latestOfficeSnapshotIdentity = source;
  }
  const explicitDemo = snapshot.capabilities.features.includes("demo");
  const profileInventoryUnavailable = !explicitDemo
    && snapshot.capabilities.runtime.state === "ready"
    && snapshot.profiles.length === 0
    && officeInventoryReliability(snapshot.inventory.profiles) !== "complete";
  officeSnapshot.value = snapshot;
  officeConnection.value = {
    state: explicitDemo ? "demo" : profileInventoryUnavailable ? "degraded" : "connected",
    source: explicitDemo ? "demo" : "server",
    serverUrl,
    runtime: snapshot.capabilities.runtime.state,
    protocolVersion: snapshot.capabilities.protocolVersion,
    generatedAt: snapshot.generatedAt,
    eventStream: officeConnection.value.eventStream,
    message: explicitDemo ? officeMessage("runtime.office.demo")
      : profileInventoryUnavailable ? officeMessage("runtime.office.profileInventoryUnavailable")
        : officeMessage("runtime.office.hermesState", { state: snapshot.capabilities.runtime.state })
  };

  if (explicitDemo) {
    loadExplicitDemoState();
    return true;
  }
  if (snapshot.capabilities.runtime.state !== "ready") {
    clearRuntimeState();
    return true;
  }
  if (profileInventoryUnavailable) {
    if (runtimeDataSource !== "live") clearRuntimeState();
    return true;
  }
  if (snapshot.profiles.length === 0) { clearRuntimeState(); return true; }
  if (runtimeDataSource === "demo") clearRuntimeState();

  const previousProfiles = new Map(profileList.value.map((profile) => [profile.id, profile]));
  const previousTargetIds = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
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
      role: previous?.role ?? "",
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
  if (snapshot.inventory.profiles.hasMore || snapshot.inventory.profiles.truncated) profileList.value = [...profileList.value, ...[...previousProfiles.values()].filter((profile) => !snapshot.profiles.some((live) => live.id === profile.id))];

  const previousSessions = sessions.value;
  const snapshotSessions = snapshot.sessions.map((live): ChatSession => {
    const previous = findStoredSession(previousSessions, live);
    return {
      ...(previous ?? { id: storedSessionClientId(live.profileId, live.id), messages: [] }),
      storedSessionId: live.id,
      profileId: live.profileId,
      title: live.title,
      titlePresentation: undefined,
      status: mergeServerSessionStatus(previous, live.activity),
      connectionState: previous?.connectionState ?? "disconnected",
      historyState: previous?.historyState ?? "unloaded",
      remoteKind: "stored",
      readOnly: previous?.connectionState !== "ready"
    };
  });
  const retainedStored = snapshot.inventory.sessions.hasMore || snapshot.inventory.sessions.truncated ? previousSessions.filter((session) => session.remoteKind === "stored" && !snapshot.sessions.some((live) => live.id === (session.storedSessionId ?? session.id) && live.profileId === session.profileId)) : [];
  const unpersistedDrafts = previousSessions.filter((session) => session.remoteKind === "draft" && !session.storedSessionId);
  sessions.value = [...snapshotSessions, ...retainedStored, ...unpersistedDrafts];

  const liveSessionIds = new Set(sessions.value.map((session) => session.id));
  const previouslyOpen = openSessionIds.value;
  openSessionIds.value = previouslyOpen.filter((id) => liveSessionIds.has(id));
  for (const removedId of previouslyOpen.filter((id) => !liveSessionIds.has(id))) releaseChatTarget(removedId);
  if (!liveSessionIds.has(activeSessionId.value)) activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  if (!profileList.value.some((profile) => profile.id === selectedProfileId.value)) {
    selectedProfileId.value = profileList.value[0]?.id ?? "";
  }
  runtimeDataSource = "live";
  for (const target of getOpenChatTargets()) if (!previousTargetIds.has(target.clientSessionId)) ensureChatSession(target);
  return true;
}

export function setOfficeEventStream(eventStream: OfficeConnection["eventStream"]): void {
  officeConnection.value = { ...officeConnection.value, eventStream };
}

export function setOfficeError(message: string, serverUrl: string, preserveRuntime = false): void {
  if (!preserveRuntime) { clearRuntimeState(); officeSnapshot.value = undefined; }
  officeConnection.value = {
    ...officeConnection.value,
    state: "error",
    source: "server",
    serverUrl,
    eventStream: "closed",
    message: officeRuntimeMessage(message)
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
    mobileWorkspaceOpen.value = false;
  }
  inspectorTab.value = "chat";
}

export function openSession(sessionId: string): void {
  if (!openSessionIds.value.includes(sessionId)) {
    const previousIds = openSessionIds.value;
    const nextIds = appendOpenSessionId(previousIds, sessionId);
    openSessionIds.value = nextIds;
    for (const evictedId of previousIds.filter((id) => !nextIds.includes(id))) releaseChatTarget(evictedId);
  }
  activeSessionId.value = sessionId;
  const session = sessions.value.find((item) => item.id === sessionId);
  if (session) {
    selectedProfileId.value = session.profileId;
    const target = chatTarget(session);
    if (target) ensureChatSession(target);
  }
}

export function appendOpenSessionId(currentIds: readonly string[], sessionId: string): string[] {
  if (currentIds.includes(sessionId)) return [...currentIds];
  return [...currentIds, sessionId].slice(-MAX_OPEN_CHAT_SESSIONS);
}

export function closeSession(sessionId: string): void {
  releaseChatTarget(sessionId);
  openSessionIds.value = openSessionIds.value.filter((id) => id !== sessionId);
  if (activeSessionId.value === sessionId) {
    activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  }
  if (openSessionIds.value.length === 0) mobileWorkspaceOpen.value = false;
}

export function createSession(profileId: string): string | undefined {
  const isLive = officeConnection.value.source === "server" && officeConnection.value.runtime === "ready";
  const isDemo = officeConnection.value.source === "demo" && officeConnection.value.state === "demo";
  if ((!isLive && !isDemo) || !profileList.value.some((profile) => profile.id === profileId)) return undefined;
  const session: ChatSession = {
    id: crypto.randomUUID(),
    profileId,
    title: "",
    titlePresentation: "new-chat",
    status: "ready",
    messages: [],
    connectionState: isLive ? "connecting" : "ready",
    historyState: "loaded",
    remoteKind: isLive ? "draft" : "demo",
    readOnly: isLive
  };
  sessions.value = [...sessions.value, session];
  openSession(session.id);
  return session.id;
}

function loadExplicitDemoState(): void {
  clearRuntimeState();
  profileList.value = profiles.map((profile) => ({ ...profile, skills: [...profile.skills], inheritedSkills: [...profile.inheritedSkills] }));
  loadKanbanDemoRuntime(createDemoKanbanApi(initialTasks, initialTaskComments, profileList.value.map((profile) => profile.id)));
  sessions.value = initialSessions.map((session) => ({
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
    connectionState: "ready",
    historyState: "loaded",
    remoteKind: "demo",
    readOnly: false
  }));
  selectedProfileId.value = profileList.value[0]?.id ?? "";
  openSessionIds.value = sessions.value.slice(0, MAX_OPEN_CHAT_SESSIONS).map((session) => session.id);
  activeSessionId.value = openSessionIds.value[0] ?? "";
  runtimeDataSource = "demo";
}

function clearRuntimeState(): void {
  for (const target of getOpenChatTargets()) releaseChatTarget(target.clientSessionId);
  profileList.value = [];
  sessions.value = [];
  resetKanbanRuntimeState();
  selectedProfileId.value = "";
  openSessionIds.value = [];
  activeSessionId.value = "";
  mobileWorkspaceOpen.value = false;
  mobileInspectorOpen.value = false;
  chatSocketState.value = { state: "disconnected", message: officeMessage("runtime.chat.waiting") };
  runtimeDataSource = "none";
}

export function sendMessage(sessionId: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session || !canSubmitChatPrompt(session)) return;
  const operationId = crypto.randomUUID();
  sessions.value = sessions.value.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          status: "streaming",
          errorMessage: undefined,
          messages: [
            ...session.messages,
            {
              id: `prompt-${operationId}`,
              from: "user",
              body: trimmed,
              at: nowTimestamp(),
              ...(session.remoteKind === "demo" ? {} : { promptOperation: { id: operationId, state: "pending" as const } }),
            }
          ]
        }
      : session
  );
  if (session.remoteKind !== "demo") {
    const submission = submitChatPrompt(sessionId, trimmed, operationId);
    if (submission === undefined) updatePromptOperation(sessionId, operationId, { status: "accepted" });
    else {
      void submission.then((result) => {
        updatePromptOperation(sessionId, operationId, result);
      }, (reason) => {
        updatePromptOperation(sessionId, operationId, {
          status: "unconfirmed",
          message: reason instanceof Error ? reason.message : "Prompt submission could not be confirmed.",
        });
      });
    }
  }
}

export async function steerSession(sessionId: string, body: string): Promise<boolean> {
  return steerChatRun(sessions, steerChatSession, sessionId, body);
}

export async function interruptSession(sessionId: string): Promise<boolean> {
  return await interruptChatRun(sessions, interruptChatSession, sessionId);
}

export async function respondToClarification(sessionId: string, answer: string): Promise<void> {
  const trimmed = answer.trim();
  const session = sessions.value.find((item) => item.id === sessionId);
  const pending = session?.pendingInteraction;
  if (!trimmed || session?.connectionState !== "ready" || pending?.kind !== "clarify" || pending.submitting) return;
  markInteractionSubmitting(sessionId, pending.id);
  try {
    await respondClarify(sessionId, pending.requestId, trimmed);
    clearInteraction(sessionId, pending.id);
  } catch {
    failInteraction(sessionId, pending.id, officeMessage("runtime.chat.answerFailed"));
  }
}

export async function respondToApproval(sessionId: string, choice: ApprovalChoice): Promise<void> {
  const session = sessions.value.find((item) => item.id === sessionId);
  const pending = session?.pendingInteraction;
  if (session?.connectionState !== "ready" || pending?.kind !== "approval" || pending.submitting) return;
  if (!pending.choices.includes(choice) || (choice === "always" && !pending.allowPermanent)) return;
  markInteractionSubmitting(sessionId, pending.id);
  try {
    await respondApproval(sessionId, pending.approvalId, choice);
    clearInteraction(sessionId, pending.id);
  } catch {
    failInteraction(sessionId, pending.id, officeMessage("runtime.chat.approvalFailed"));
  }
}

export function reconnectChatSession(sessionId: string): void {
  const session = sessions.value.find((item) => item.id === sessionId);
  const target = session ? chatTarget(session) : undefined;
  if (target) ensureChatSession(target);
}

export function setChatSocketState(state: ChatConnectionState, message = ""): void {
  chatSocketState.value = { state, message: message ? officeRuntimeMessage(message) : officeMessage("runtime.chat.waiting") };
}

export function setChatHistoryLoading(sessionId: string, resetTranscript = false): void {
  updateChatSession(sessionId, (session) => ({
    ...session,
    historyState: "loading",
    ...(resetTranscript ? {
      // Hermes history cannot reconstruct these queue acknowledgements. Keep the
      // bounded, local operation evidence while replacing the durable transcript.
      messages: boundedChatOperationEvidence(session.messages),
      streamingMessageId: undefined,
      historyPartial: false,
      historyNotice: undefined,
    } : {}),
  }));
}

export function applyChatHistory(sessionId: string, history: ChatMessage[], resolvedStoredSessionId?: string, result?: ChatHistoryResult): void {
  updateChatSession(sessionId, (session) => {
    const historyIds = new Set(history.map((message) => message.id));
    const localMessages = reconcilePromptOperationsWithHistory(session.messages, history)
      .filter((message) => !historyIds.has(message.id));
    return {
      ...session,
      ...(resolvedStoredSessionId ? { storedSessionId: resolvedStoredSessionId, remoteKind: "stored" as const } : {}),
      historyState: "loaded",
      historyPartial: result?.partial === true, historyNotice: result?.error ? officeRuntimeMessage(result.error) : undefined,
      errorMessage: session.connectionState === "error" ? session.errorMessage : undefined,
      messages: [...history, ...localMessages]
    };
  });
}

function updatePromptOperation(sessionId: string, operationId: string, result: ChatPromptResult): void {
  updateChatSession(sessionId, (session) => {
    let found = false;
    const messages = session.messages.map((message) => {
      if (message.promptOperation?.id !== operationId || message.promptOperation.state !== "pending") return message;
      found = true;
      return {
        ...message,
        promptOperation: {
          id: operationId,
          state: result.status,
          ...(result.status === "accepted" ? {} : { message: result.message }),
        },
        ...(result.status === "rejected" ? { status: "failed" as const } : {}),
      };
    });
    if (!found) return session;
    return {
      ...session,
      messages,
      ...(result.status === "rejected" || result.status === "unconfirmed" ? { status: "ready" as const } : {}),
    };
  });
}

export function reconcilePromptOperationsWithHistory(local: readonly ChatMessage[], _history: readonly ChatMessage[]): ChatMessage[] {
  // Hermes history does not currently carry the client operation id. Text and
  // timestamps cannot prove causality (clocks may differ and short prompts are
  // commonly repeated), so retain bounded local evidence. applyChatHistory
  // still removes an operation if a future durable row has the exact same id.
  return [...local];
}

export function setChatHistoryError(sessionId: string, message: string): void {
  updateChatSession(sessionId, (session) => ({ ...session, historyState: "error", errorMessage: officeRuntimeMessage(message) }));
}

export function setChatSessionConnecting(sessionId: string): void {
  updateChatSession(sessionId, reconcileChatSessionConnecting);
}

export function setChatSessionReady(sessionId: string, liveSessionId: string, storedSessionId?: string, runtime?: ChatSessionReadyRuntime): void {
  updateChatSession(sessionId, (session) => reconcileChatSessionReady(session, liveSessionId, storedSessionId, runtime));
}

export function setChatSessionDisconnected(sessionId: string): void {
  updateChatSession(sessionId, reconcileChatSessionDisconnected);
}

export function setChatSessionError(sessionId: string, message: string): void {
  updateChatSession(sessionId, (session) => reconcileChatSessionError(session, officeRuntimeMessage(message)));
}

export function applyChatGatewayEvent(sessionId: string, event: ChatGatewayEvent): void {
  updateChatSession(sessionId, (session) => reduceChatGatewayEvent(session, event));
}

export function reduceChatGatewayEvent(session: ChatSession, event: ChatGatewayEvent): ChatSession {
  const payload = event.payload ?? {};
  if (event.type === "clarify.request") {
    const requestId = stringValue(payload.requestId) ?? stringValue(payload.request_id);
    const question = stringValue(payload.question);
    if (!requestId || !question) return session;
    return withPendingInteraction(session, {
      id: `clarify:${requestId}`,
      kind: "clarify",
      requestId,
      question,
      choices: stringArray(payload.choices),
      submitting: false
    });
  }
  if (event.type === "approval.request") {
    const approvalId = stringValue(payload.approvalId) ?? stringValue(payload.approval_id);
    const command = stringValue(payload.command);
    const description = stringValue(payload.description);
    const allowPermanent = (payload.allowPermanent === true || payload.allow_permanent === true)
      && officeSnapshot.value?.capabilities.access.allowedOperations.includes("chat.approval.permanent") === true;
    const choices = approvalChoices(payload.choices, allowPermanent);
    if (!approvalId || choices.length === 0) return session;
    return withPendingInteraction(session, {
      id: `approval:${approvalId}`,
      kind: "approval",
      approvalId,
      ...(command ? { command } : {}),
      ...(description ? { description } : {}),
      choices,
      allowPermanent,
      submitting: false
    });
  }
  if (event.type === "message.start") {
    const messageId = gatewayMessageId(payload) ?? `stream-${event.liveSessionId}-${Date.now()}`;
    return {
      ...session,
      status: "streaming",
      streamingMessageId: messageId,
      messages: [...session.messages, { id: messageId, from: "agent", body: "", at: nowTimestamp(), status: "streaming" }]
    };
  }
  if (event.type === "message.delta") {
    const delta = stringValue(payload.text) ?? stringValue(payload.delta) ?? "";
    if (!delta) return session;
    const messageId = gatewayMessageId(payload) ?? session.streamingMessageId ?? `stream-${event.liveSessionId}`;
    const exists = session.messages.some((message) => message.id === messageId);
    return {
      ...session,
      status: "streaming",
      streamingMessageId: messageId,
      messages: exists
        ? session.messages.map((message) => message.id === messageId ? { ...message, body: message.body + delta, status: "streaming" } : message)
        : [...session.messages, { id: messageId, from: "agent", body: delta, at: nowTimestamp(), status: "streaming" }]
    };
  }
  if (event.type === "message.complete") {
    const messageId = gatewayMessageId(payload) ?? session.streamingMessageId ?? `complete-${event.liveSessionId}-${Date.now()}`;
    const completeText = stringValue(payload.text);
    const exists = session.messages.some((message) => message.id === messageId);
    return {
      ...session,
      status: "ready",
      streamingMessageId: undefined,
      pendingInteraction: undefined,
      interruptPending: false,
      interruptOperationId: undefined,
      messages: exists
        ? session.messages.map((message) => message.id === messageId ? { ...message, body: completeText || message.body, status: "complete" } : message.status === "streaming" ? { ...message, status: "complete" } : message)
        : [...session.messages.map((message) => message.status === "streaming" ? { ...message, status: "complete" as const } : message), ...(completeText ? [{ id: messageId, from: "agent" as const, body: completeText, at: nowTimestamp(), status: "complete" as const }] : [])]
    };
  }
  if (event.type === "status.update") {
    return isChatRunActive(session) ? mergeGatewayStatusUpdate(session, payload) : session;
  }
  if (event.type === "session.info") {
    const status = stringValue(payload.status)?.trim().toLowerCase().replaceAll("_", "-");
    if (session.interruptPending && (payload.running === false || status === "idle" || status === "ready")) {
      return {
        ...session,
        status: "ready",
        streamingMessageId: undefined,
        pendingInteraction: undefined,
        interruptPending: false,
        interruptOperationId: undefined,
        messages: session.messages.map((item) => item.status === "streaming" ? { ...item, status: "cancelled" } : item),
      };
    }
    return session;
  }
  if (event.type.startsWith("tool.")) {
    const toolId = stringValue(payload.toolId) ?? stringValue(payload.tool_id) ?? `tool-${event.liveSessionId}`;
    const name = stringValue(payload.name);
    const detail = stringValue(payload.summary) ?? stringValue(payload.status);
    const phase = event.type === "tool.complete" ? "complete" as const : "running" as const;
    const status = phase === "complete" ? "complete" as const : "streaming" as const;
    const body = detail ? `${name ?? "Tool"}: ${detail}` : "";
    const presentation = detail ? undefined : { kind: "tool-fallback" as const, ...(name ? { name } : {}), phase };
    const exists = session.messages.some((message) => message.id === toolId);
    return {
      ...session,
      status: event.type === "tool.complete" ? session.status : "streaming",
      messages: exists
        ? session.messages.map((message) => message.id === toolId ? { ...message, body, presentation, status } : message)
        : [...session.messages, { id: toolId, from: "tool", body, presentation, at: nowTimestamp(), status }]
    };
  }
  if (event.type === "error") {
    const upstreamText = stringValue(payload.message);
    return {
      ...session,
      status: "ready",
      errorMessage: upstreamText ? upstreamMessage(upstreamText) : officeMessage("runtime.chat.hermesGenericError"),
      streamingMessageId: undefined,
      pendingInteraction: undefined,
      interruptPending: false,
      interruptOperationId: undefined,
      messages: session.messages.map((item) => item.status === "streaming" ? { ...item, status: "failed" } : item)
    };
  }
  return session;
}

function withPendingInteraction(session: ChatSession, interaction: ChatPendingInteraction): ChatSession {
  const current = session.pendingInteraction;
  const pendingInteraction = current?.id === interaction.id
    ? { ...interaction, submitting: current.submitting, error: current.error }
    : interaction;
  return { ...session, status: "waiting", pendingInteraction };
}

function markInteractionSubmitting(sessionId: string, interactionId: string): void {
  updateChatSession(sessionId, (session) => session.pendingInteraction?.id === interactionId
    ? { ...session, pendingInteraction: { ...session.pendingInteraction, submitting: true, error: undefined } }
    : session);
}

function clearInteraction(sessionId: string, interactionId: string): void {
  updateChatSession(sessionId, (session) => session.pendingInteraction?.id === interactionId
    ? { ...session, status: "streaming", pendingInteraction: undefined }
    : session);
}

function failInteraction(sessionId: string, interactionId: string, error: RuntimeMessage): void {
  updateChatSession(sessionId, (session) => session.pendingInteraction?.id === interactionId
    ? { ...session, pendingInteraction: { ...session.pendingInteraction, submitting: false, error } }
    : session);
}

function chatTarget(session: ChatSession): ChatTarget | undefined {
  if (!session.remoteKind || session.remoteKind === "demo") return undefined;
  return {
    clientSessionId: session.id,
    profileId: session.profileId,
    ...(session.storedSessionId ? { storedSessionId: session.storedSessionId } : {})
  };
}

function updateChatSession(sessionId: string, update: (session: ChatSession) => ChatSession): void {
  sessions.value = sessions.value.map((session) => session.id === sessionId ? update(session) : session);
}

function releaseChatTarget(sessionId: string): void {
  updateChatSession(sessionId, reconcileChatSessionDisconnected);
  releaseChatSession(sessionId);
}
