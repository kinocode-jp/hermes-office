import { officeInventoryReliability } from "@hermes-studio/protocol";
import { initialSessions, initialTaskComments, initialTasks, initialTeams, profiles } from "./demo-data";
import { createDemoKanbanApi } from "./demo-kanban-api";
import { loadTeamsDemoRuntime, resetTeamsRuntimeState } from "./teams-store";
import type { ChatTarget } from "./chat-api";
import type { OfficeSnapshot, OfficeSnapshotRequestIdentity, Profile, Surface } from "./domain";
import type { DeviceLoginFailure } from "./auth-state";
import { loadKanbanDemoRuntime, registerKanbanProfileTaskUpdater, resetKanbanRuntimeState } from "./kanban-store";
import { findStoredSession, storedSessionClientId } from "./session-identity";
import { mergeServerSessionStatus } from "./session-runtime";
import { reconcileChatSessionDisconnected } from "./chat-session-reconciliation";
import { reconcileDefaultAvatarProfiles, registerDefaultAvatarProfiles } from "./avatar-preferences";
import { ensurePokemonDisplayNames } from "./profile-names";
import { resolvedCreateModelPrefs } from "./chat-model-prefs";
import { setOfficeWindowOpen } from "./office-window";
import { officeMessage, officeRuntimeMessage } from "./i18n";
import { isRecurringSessionHidden } from "./recurring-jobs";
import {
  buildCardAskSeedPrompt,
  cardAskSeedInputFromTask,
  findCardAskSession,
} from "./kanban-ask";
import {
  clearMobileRoutes,
  noteMobileWorkspaceClosed,
  openMobileInspector,
  openMobileWorkspace,
} from "./mobile-routes";
import {
  MAX_OPEN_CHAT_SESSIONS,
  activeSessionId,
  activeSurface,
  chatSocketState,
  inspectorTab,
  latestOfficeSnapshotIdentity,
  officeAccess,
  officeConnection,
  officeRuntimeHooks,
  officeSnapshot,
  openSessionIds,
  profileList,
  profileDetailModalId,
  profileSettingsModalId,
  profileChatModalId,
  recurringJobsOpen,
  runtimeDataSource,
  selectedProfile,
  selectedProfileId,
  selectedProfileSessions,
  sessions,
  settingsTab,
  setLatestOfficeSnapshotIdentity,
  setRuntimeDataSource,
} from "./store-state";
import { persistUiNavPreferences } from "./ui-nav-prefs";

export {
  MAX_OPEN_CHAT_SESSIONS,
  activeSessionId,
  activeSurface,
  chatSocketState,
  inspectorTab,
  mobileInspectorOpen,
  mobileWorkspaceOpen,
  officeAccess,
  officeConnection,
  officeSnapshot,
  openSessionIds,
  profileDetailModalId,
  profileList,
  profileSettingsModalId,
  profileChatModalId,
  recurringJobsOpen,
  selectedProfile,
  selectedProfileId,
  selectedProfileSessions,
  sessions,
  settingsTab,
} from "./store-state";

export {
  clearMobileRoutes,
  closeMobileRoute,
  installMobileRouteHistory,
  openMobileInspector,
  openMobileWorkspace,
} from "./mobile-routes";

export { addTaskComment, assignTask, createTask, expandedTaskId, kanbanAssignees, kanbanState, moveTask, refreshKanbanBoard, registerKanbanRuntime, retryTaskComments, taskCommentDetail, tasks, toggleTaskComments } from "./kanban-store";
import {
  applyChatGatewayEvent,
  applyChatHistory,
  applySessionModelPrefs,
  clearFollowUpSuggestions,
  interruptSession,
  reconcilePromptOperationsWithHistory,
  reconnectChatSession,
  reduceChatGatewayEvent,
  refreshFollowUpSuggestions,
  respondToApproval,
  respondToClarification,
  sendMessage,
  setChatHistoryError,
  setChatHistoryLoading,
  setChatSessionConnecting,
  setChatSessionDisconnected,
  setChatSessionError,
  setChatSessionReady,
  setChatSocketState,
  steerSession,
  tryFlushCardSeed,
} from "./store-chat";

export {
  applyChatGatewayEvent,
  applyChatHistory,
  applySessionModelPrefs,
  clearFollowUpSuggestions,
  interruptSession,
  reconcilePromptOperationsWithHistory,
  reconnectChatSession,
  reduceChatGatewayEvent,
  refreshFollowUpSuggestions,
  respondToApproval,
  respondToClarification,
  sendMessage,
  setChatHistoryError,
  setChatHistoryLoading,
  setChatSessionConnecting,
  setChatSessionDisconnected,
  setChatSessionError,
  setChatSessionReady,
  setChatSocketState,
  steerSession,
  tryFlushCardSeed,
};

registerKanbanProfileTaskUpdater((counts) => {
  profileList.value = profileList.value.map((profile) => ({ ...profile, taskCount: counts.get(profile.id) ?? 0 }));
});

export function navigateToSurface(surface: Surface): void {
  // Legacy "library" was global agent settings; fold it into Settings.
  if (surface === "library") {
    activeSurface.value = "settings";
    settingsTab.value = "global";
  } else {
    activeSurface.value = surface;
  }
  if (activeSurface.value === "office") setOfficeWindowOpen(true);
  clearMobileRoutes();
  persistNavigationState();
}

function persistNavigationState(): void {
  persistUiNavPreferences({
    surface: activeSurface.value,
    settingsTab: settingsTab.value,
    selectedProfileId: selectedProfileId.value,
  });
}

export function registerChatRuntime(actions: {
  ensureSession(target: ChatTarget): void;
  releaseSession(clientSessionId: string): void;
  submitPrompt(clientSessionId: string, text: string, operationId: string): Promise<import("./chat-api").ChatPromptResult> | void;
  steer(clientSessionId: string, text: string): Promise<import("./chat-api").ChatSteerResult>;
  interrupt(clientSessionId: string): Promise<void> | void;
  respondClarify(clientSessionId: string, requestId: string, answer: string): Promise<void>;
  respondApproval(clientSessionId: string, approvalId: string, choice: import("./domain").ApprovalChoice): Promise<void>;
}): void {
  officeRuntimeHooks.ensureChatSession = actions.ensureSession;
  officeRuntimeHooks.releaseChatSession = actions.releaseSession;
  officeRuntimeHooks.submitChatPrompt = actions.submitPrompt;
  officeRuntimeHooks.steerChatSession = actions.steer;
  officeRuntimeHooks.interruptChatSession = actions.interrupt;
  officeRuntimeHooks.respondClarify = actions.respondClarify;
  officeRuntimeHooks.respondApproval = actions.respondApproval;
  for (const target of getOpenChatTargets()) officeRuntimeHooks.ensureChatSession(target);
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
  officeRuntimeHooks.retryOfficeConnection = action;
}

export function retryOfficeServer(): void {
  officeAccess.value = { ...officeAccess.value, state: "checking", message: officeMessage("runtime.office.reconnecting") };
  officeRuntimeHooks.retryOfficeConnection();
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
    setLatestOfficeSnapshotIdentity(source);
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
  if (snapshot.profiles.length === 0) {
    if (officeInventoryReliability(snapshot.inventory.profiles) === "complete" && !snapshot.inventory.profiles.hasMore) {
      reconcileDefaultAvatarProfiles([]);
    }
    clearRuntimeState();
    return true;
  }
  if (runtimeDataSource === "demo") clearRuntimeState();

  const previousProfiles = new Map(profileList.value.map((profile) => [profile.id, profile]));
  const previousTargetIds = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  const sessionCounts = new Map<string, number>();
  for (const session of snapshot.sessions) {
    if (isRecurringSessionHidden(storedSessionClientId(session.profileId, session.id))) continue;
    sessionCounts.set(session.profileId, (sessionCounts.get(session.profileId) ?? 0) + 1);
  }
  const palette = ["#64b7a7", "#e07a55", "#d6a94f", "#8499c8", "#55d6be", "#f06a57"];
  const snapshotProfileIds = snapshot.profiles.map((profile) => profile.id);
  if (officeInventoryReliability(snapshot.inventory.profiles) === "complete" && !snapshot.inventory.profiles.hasMore) {
    reconcileDefaultAvatarProfiles(snapshotProfileIds);
  } else {
    registerDefaultAvatarProfiles(snapshotProfileIds);
  }
  ensurePokemonDisplayNames(snapshotProfileIds);
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
  const snapshotSessions = snapshot.sessions.filter((live) => !isRecurringSessionHidden(storedSessionClientId(live.profileId, live.id))).map((live): import("./domain").ChatSession => {
    const previous = findStoredSession(previousSessions, live);
    return {
      ...(previous ?? { id: storedSessionClientId(live.profileId, live.id), messages: [] }),
      storedSessionId: live.id,
      profileId: live.profileId,
      title: live.title,
      titlePresentation: undefined,
      ...(live.createdAt === undefined ? {} : { createdAt: live.createdAt }),
      ...(live.updatedAt === undefined ? {} : { updatedAt: live.updatedAt }),
      ...(live.lastMessagePreview === undefined ? {} : { lastMessagePreview: live.lastMessagePreview }),
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
  setRuntimeDataSource("live");
  for (const target of getOpenChatTargets()) if (!previousTargetIds.has(target.clientSessionId)) officeRuntimeHooks.ensureChatSession(target);
  return true;
}

export function setOfficeEventStream(eventStream: import("./domain").OfficeConnection["eventStream"]): void {
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

function updateProfileSessionCounts(): void {
  const counts = new Map<string, number>();
  for (const session of sessions.value) if (session.remoteKind !== "demo") counts.set(session.profileId, (counts.get(session.profileId) ?? 0) + 1);
  profileList.value = profileList.value.map((profile) => ({ ...profile, sessions: counts.get(profile.id) ?? 0 }));
}

export function selectProfile(profileId: string, options?: { openWorkspace?: boolean; openDetail?: boolean }): void {
  selectedProfileId.value = profileId;
  inspectorTab.value = "chat";
  persistNavigationState();
  if (options?.openWorkspace) {
    const existing = sessions.value.find((session) => session.profileId === profileId);
    if (existing) openSession(existing.id);
    else createSession(profileId);
    // Office floor / character click: chat workspace only on mobile (not the inspector).
    openMobileWorkspace();
    return;
  }
  if (options?.openDetail !== false) {
    openProfileChatModal(profileId);
    return;
  }
  openMobileInspector();
}

export function openProfileDetailModal(profileId: string): void {
  selectedProfileId.value = profileId;
  profileDetailModalId.value = profileId;
  persistNavigationState();
}

export function closeProfileDetailModal(): void {
  profileDetailModalId.value = null;
}

export function openProfileSettingsModal(profileId: string): void {
  selectedProfileId.value = profileId;
  profileSettingsModalId.value = profileId;
  persistNavigationState();
}

export function closeProfileSettingsModal(): void {
  profileSettingsModalId.value = null;
}

export function openProfileChatModal(profileId: string): void {
  selectedProfileId.value = profileId;
  profileChatModalId.value = profileId;
  persistNavigationState();
}

export function closeProfileChatModal(): void {
  profileChatModalId.value = null;
}

export function openRecurringJobs(): void {
  recurringJobsOpen.value = true;
}

export function closeRecurringJobs(): void {
  recurringJobsOpen.value = false;
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
    if (target) officeRuntimeHooks.ensureChatSession(target);
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
  if (openSessionIds.value.length === 0) noteMobileWorkspaceClosed();
}

export function dismissSessions(sessionIds: readonly string[]): void {
  const ids = new Set(sessionIds);
  if (ids.size === 0) return;
  for (const sessionId of ids) releaseChatTarget(sessionId);
  sessions.value = sessions.value.filter((session) => !ids.has(session.id));
  openSessionIds.value = openSessionIds.value.filter((sessionId) => !ids.has(sessionId));
  if (ids.has(activeSessionId.value)) activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  updateProfileSessionCounts();
  if (openSessionIds.value.length === 0) noteMobileWorkspaceClosed();
}

/**
 * Open or reuse a chat with the Kanban card's assignee for confirmation Q&A.
 * Does not change card status or call Hermes dispatch.
 */
export function askAssigneeAboutTask(task: import("./domain").WorkTask): string | undefined {
  const assigneeId = task.assigneeId;
  if (!assigneeId || task.pending) return undefined;

  const existing = findCardAskSession(sessions.value, task.id, assigneeId);
  if (existing) {
    openSession(existing.id);
    openMobileWorkspace();
    return existing.id;
  }

  const sessionId = createSession(assigneeId);
  if (sessionId === undefined) return undefined;

  const seed = buildCardAskSeedPrompt(cardAskSeedInputFromTask({ ...task, assigneeId }));
  sessions.value = sessions.value.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          sourceCardId: task.id,
          sourceCardTitle: task.title,
          sourceCardSeeded: false,
          pendingCardSeed: seed,
          title: task.title,
          titlePresentation: undefined,
        }
      : session,
  );
  openMobileWorkspace();
  tryFlushCardSeed(sessionId);
  return sessionId;
}

export function createSession(profileId: string): string | undefined {
  const isLive = officeConnection.value.source === "server" && officeConnection.value.runtime === "ready";
  const isDemo = officeConnection.value.source === "demo" && officeConnection.value.state === "demo";
  if ((!isLive && !isDemo) || !profileList.value.some((profile) => profile.id === profileId)) return undefined;
  // Effort on prefs is only set after live-enum apply (or cleared). Shape-sanitize here.
  const { model, provider, reasoningEffort } = resolvedCreateModelPrefs();
  const session: import("./domain").ChatSession = {
    id: crypto.randomUUID(),
    profileId,
    title: "",
    titlePresentation: "new-chat",
    status: "ready",
    messages: [],
    connectionState: isLive ? "connecting" : "ready",
    historyState: "loaded",
    remoteKind: isLive ? "draft" : "demo",
    readOnly: isLive,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  sessions.value = [...sessions.value, session];
  openSession(session.id);
  return session.id;
}

function loadExplicitDemoState(): void {
  clearRuntimeState();
  reconcileDefaultAvatarProfiles(profiles.map((profile) => profile.id));
  ensurePokemonDisplayNames(profiles.map((profile) => profile.id));
  profileList.value = profiles.map((profile) => ({ ...profile, skills: [...profile.skills], inheritedSkills: [...profile.inheritedSkills] }));
  loadKanbanDemoRuntime(createDemoKanbanApi(initialTasks, initialTaskComments, profileList.value.map((profile) => profile.id)));
  loadTeamsDemoRuntime(initialTeams);
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
  setRuntimeDataSource("demo");
}

function clearRuntimeState(): void {
  for (const target of getOpenChatTargets()) releaseChatTarget(target.clientSessionId);
  profileList.value = [];
  sessions.value = [];
  resetKanbanRuntimeState();
  resetTeamsRuntimeState();
  selectedProfileId.value = "";
  openSessionIds.value = [];
  activeSessionId.value = "";
  clearMobileRoutes();
  chatSocketState.value = { state: "disconnected", message: officeMessage("runtime.chat.waiting") };
  setRuntimeDataSource("none");
}

function chatTarget(session: import("./domain").ChatSession): ChatTarget | undefined {
  if (!session.remoteKind || session.remoteKind === "demo") return undefined;
  // Session effort was set via apply (live allowlist) or createSession from validated prefs.
  const resolved = resolvedCreateModelPrefs({
    provider: session.provider ?? "",
    model: session.model ?? "",
    reasoningEffort: session.reasoningEffort ?? "",
  });
  return {
    clientSessionId: session.id,
    profileId: session.profileId,
    ...(session.storedSessionId ? { storedSessionId: session.storedSessionId } : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.provider ? { provider: resolved.provider } : {}),
    ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
  };
}

function releaseChatTarget(sessionId: string): void {
  sessions.value = sessions.value.map((session) => session.id === sessionId ? reconcileChatSessionDisconnected(session) : session);
  officeRuntimeHooks.releaseChatSession(sessionId);
}
