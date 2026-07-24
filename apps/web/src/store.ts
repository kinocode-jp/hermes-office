import { officeInventoryReliability } from "@hermes-studio/protocol";
import { initialSessions, initialTaskComments, initialTasks, initialTeams, profiles } from "./demo-data";
import { createDemoKanbanApi } from "./demo-kanban-api";
import { loadTeamsDemoRuntime, resetTeamsRuntimeState } from "./teams-store";
import type { ChatTarget } from "./chat-api";
import type { OfficeSnapshot, OfficeSnapshotRequestIdentity, Profile, SettingsTab, Surface } from "./domain";
import type { DeviceLoginFailure } from "./auth-state";
import { loadKanbanDemoRuntime, registerKanbanProfileTaskUpdater, resetKanbanRuntimeState } from "./kanban-store";
import { prefetchSelectedProfileSettings } from "./settings-prefetch";
import { findStoredSession, storedSessionClientId } from "./session-identity";
import { isScheduledSessionHidden } from "./scheduled-sessions";
import { deleteStoredSession } from "./sessions-api";
import { mergeServerSessionStatus } from "./session-runtime";
import { reconcileChatSessionDisconnected } from "./chat-session-reconciliation";
import { reconcileDefaultAvatarProfiles, registerDefaultAvatarProfiles } from "./avatar-preferences";
import { ensurePokemonDisplayNames } from "./profile-names";
import { resolvedCreateModelPrefs } from "./chat-model-prefs";
import { setOfficeWindowOpen } from "./office-window";
import { officeMessage, officeRuntimeMessage } from "./i18n";
import {
  buildCardAskSeedPrompt,
  cardAskSeedInputFromTask,
  findCardAskSession,
} from "./kanban-ask";
import {
  clearMobileRoutes,
  noteMobileWorkspaceClosed,
  openMobileWorkspace,
} from "./mobile-routes";
import {
  MAX_OPEN_CHAT_SESSIONS,
  MAX_PROFILE_CHAT_MODAL_PANES,
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
  workspaceSessionDropPreview,
  workspaceSessionDropPlacement,
  profileList,
  profileSettingsModalId,
  profileSettingsModalTab,
  settingsModalOpen,
  profileChatModalId,
  profileChatModalPaneIds,
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
  MAX_PROFILE_CHAT_MODAL_PANES,
  activeSessionId,
  activeSurface,
  chatSocketState,
  inspectorTab,
  mobileInspectorOpen,
  mobileWorkspaceOpen,
  workspaceSessionDropPreview,
  workspaceSessionDropPlacement,
  officeAccess,
  officeConnection,
  officeSnapshot,
  openSessionIds,
  profileList,
  profileSettingsModalId,
  profileSettingsModalTab,
  settingsModalOpen,
  profileChatModalId,
  profileChatModalPaneIds,
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
  consumeCardSeed,
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
  consumeCardSeed,
};

registerKanbanProfileTaskUpdater((counts) => {
  profileList.value = profileList.value.map((profile) => ({ ...profile, taskCount: counts.get(profile.id) ?? 0 }));
});

export function navigateToSurface(surface: Surface): void {
  // Settings is a header modal, not a main surface.
  if (surface === "settings" || surface === "library") {
    openSettingsModal(surface === "library" ? "global" : settingsTab.value);
    return;
  }
  activeSurface.value = surface;
  // Leaving another surface closes the settings modal so the floor stays primary.
  settingsModalOpen.value = false;
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
  const snapshotSessions = snapshot.sessions
    .filter((live) => !isScheduledSessionHidden({
      id: live.id,
      storedSessionId: live.id,
      profileId: live.profileId,
      title: live.title,
      titlePresentation: undefined,
    }))
    .map((live): import("./domain").ChatSession => {
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
  sessions.value = [
    ...snapshotSessions,
    ...retainedStored.filter((session) => !isScheduledSessionHidden(session)),
    ...unpersistedDrafts,
  ];

  const liveSessionIds = new Set(sessions.value.map((session) => session.id));
  const previouslyOpen = openSessionIds.value;
  openSessionIds.value = previouslyOpen.filter((id) => liveSessionIds.has(id));
  for (const removedId of previouslyOpen.filter((id) => !liveSessionIds.has(id))) releaseChatTarget(removedId);
  if (!liveSessionIds.has(activeSessionId.value)) activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  if (!profileList.value.some((profile) => profile.id === selectedProfileId.value)) {
    selectedProfileId.value = profileList.value[0]?.id ?? "";
    prefetchSelectedProfileSettings(selectedProfileId.value || null);
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
  for (const session of sessions.value) {
    if (session.remoteKind === "demo" || isScheduledSessionHidden(session)) continue;
    counts.set(session.profileId, (counts.get(session.profileId) ?? 0) + 1);
  }
  profileList.value = profileList.value.map((profile) => ({ ...profile, sessions: counts.get(profile.id) ?? 0 }));
}

export function selectProfile(profileId: string, options?: { openWorkspace?: boolean; openDetail?: boolean }): void {
  selectedProfileId.value = profileId;
  prefetchSelectedProfileSettings(profileId);
  inspectorTab.value = "chat";
  persistNavigationState();
  if (options?.openWorkspace) {
    const existing = sessions.value.find((session) => session.profileId === profileId);
    if (existing) openSession(existing.id);
    else createSession(profileId);
    // Studio floor / character click: chat workspace only on mobile (not the inspector).
    openMobileWorkspace();
    return;
  }
  if (options?.openDetail !== false) {
    openProfileChatModal(profileId);
  }
}


export function openScheduledSessions(): void {
  navigateToSurface("scheduled");
}

export function closeScheduledSessions(): void {
  if (activeSurface.value === "scheduled") navigateToSurface("office");
}

export function openSettingsModal(tab: SettingsTab = "global"): void {
  settingsTab.value = tab === "host" ? "host" : "global";
  settingsModalOpen.value = true;
  persistNavigationState();
}

export function closeSettingsModal(): void {
  settingsModalOpen.value = false;
  persistNavigationState();
}

export function openProfileSettingsModal(profileId: string, tab: SettingsTab = "soul"): void {
  selectedProfileId.value = profileId;
  prefetchSelectedProfileSettings(profileId);
  profileSettingsModalId.value = profileId;
  // Profile settings stay modal-scoped; only profile-owned tabs are accepted.
  profileSettingsModalTab.value = tab === "global" || tab === "host" ? "soul" : tab;
  persistNavigationState();
}

export function closeProfileSettingsModal(): void {
  profileSettingsModalId.value = null;
}

export function openProfileChatModal(profileId: string, options?: { sessionId?: string }): void {
  selectedProfileId.value = profileId;
  prefetchSelectedProfileSettings(profileId);
  profileChatModalId.value = profileId;
  if (options?.sessionId) {
    profileChatModalPaneIds.value = [options.sessionId];
    ensureSessionConnection(options.sessionId);
  } else {
    profileChatModalPaneIds.value = [];
  }
  persistNavigationState();
}

export function closeProfileChatModal(): void {
  profileChatModalId.value = null;
  profileChatModalPaneIds.value = [];
}

export function addProfileChatModalPane(sessionId: string): boolean {
  const modalProfileId = profileChatModalId.value;
  if (!modalProfileId) return false;
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session || session.profileId !== modalProfileId) return false;
  const current = profileChatModalPaneIds.value;
  if (current.includes(sessionId)) {
    ensureSessionConnection(sessionId);
    return true;
  }
  if (current.length >= MAX_PROFILE_CHAT_MODAL_PANES) return false;
  profileChatModalPaneIds.value = [...current, sessionId];
  ensureSessionConnection(sessionId);
  return true;
}

export function removeProfileChatModalPane(sessionId: string): void {
  profileChatModalPaneIds.value = profileChatModalPaneIds.value.filter((id) => id !== sessionId);
}

export function setProfileChatModalPanes(sessionIds: readonly string[]): void {
  const modalProfileId = profileChatModalId.value;
  if (!modalProfileId) {
    profileChatModalPaneIds.value = [];
    return;
  }
  const allowed = sessionIds.filter((sessionId) => {
    const session = sessions.value.find((item) => item.id === sessionId);
    return Boolean(session && session.profileId === modalProfileId);
  });
  const unique: string[] = [];
  for (const id of allowed) {
    if (!unique.includes(id)) unique.push(id);
    if (unique.length >= MAX_PROFILE_CHAT_MODAL_PANES) break;
  }
  profileChatModalPaneIds.value = unique;
  for (const id of unique) ensureSessionConnection(id);
}


export function setWorkspaceSessionDropPreview(active: boolean): void {
  workspaceSessionDropPreview.value = active;
  if (!active) workspaceSessionDropPlacement.value = null;
}

export function setWorkspaceSessionDropPlacement(placement: "top" | "right" | "bottom" | "left" | null): void {
  workspaceSessionDropPlacement.value = placement;
  if (placement) workspaceSessionDropPreview.value = true;
}

export function clearWorkspaceSessionDropPreview(): void {
  workspaceSessionDropPreview.value = false;
  workspaceSessionDropPlacement.value = null;
}

export function ensureSessionConnection(sessionId: string): void {
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session) return;
  selectedProfileId.value = session.profileId;
  prefetchSelectedProfileSettings(session.profileId);
  const needsEnsure = session.connectionState !== "ready"
    || session.historyState === "error"
    || session.connectionState === "error"
    || session.connectionState === "disconnected"
    || session.historyState === "unloaded";
  if (!needsEnsure) return;
  const target = chatTarget(session);
  if (target) officeRuntimeHooks.ensureChatSession(target);
}

export function openSession(sessionId: string, options?: { workspace?: boolean; index?: number }): void {
  const addToWorkspace = options?.workspace !== false;
  const wasOpen = openSessionIds.value.includes(sessionId);
  if (addToWorkspace) {
    if (!wasOpen) {
      const previousIds = openSessionIds.value;
      const nextIds = appendOpenSessionId(previousIds, sessionId, options?.index);
      openSessionIds.value = nextIds;
      for (const evictedId of previousIds.filter((id) => !nextIds.includes(id))) releaseChatTarget(evictedId);
    } else if (typeof options?.index === "number") {
      openSessionIds.value = moveOpenSessionId(openSessionIds.value, sessionId, options.index);
    }
    activeSessionId.value = sessionId;
  }
  const session = sessions.value.find((item) => item.id === sessionId);
  if (session) {
    selectedProfileId.value = session.profileId;
  prefetchSelectedProfileSettings(session.profileId);
    const needsEnsure = (addToWorkspace && !wasOpen)
      || session.connectionState !== "ready"
      || session.historyState === "error"
      || session.connectionState === "error"
      || session.connectionState === "disconnected"
      || session.historyState === "unloaded";
    if (needsEnsure) {
      const target = chatTarget(session);
      if (target) officeRuntimeHooks.ensureChatSession(target);
    }
  }
}

export function appendOpenSessionId(currentIds: readonly string[], sessionId: string, index?: number): string[] {
  if (currentIds.includes(sessionId)) return [...currentIds];
  const next = [...currentIds];
  const insertAt = typeof index === "number"
    ? Math.max(0, Math.min(next.length, Math.floor(index)))
    : next.length;
  next.splice(insertAt, 0, sessionId);
  if (next.length <= MAX_OPEN_CHAT_SESSIONS) return next;
  // Prefer keeping the newly inserted session; drop from the far end.
  if (insertAt >= next.length - 1) return next.slice(-MAX_OPEN_CHAT_SESSIONS);
  return next.slice(0, MAX_OPEN_CHAT_SESSIONS);
}

export function moveOpenSessionId(currentIds: readonly string[], sessionId: string, index: number): string[] {
  const from = currentIds.indexOf(sessionId);
  if (from < 0) return [...currentIds];
  // `index` is a visual insert position computed while the dragged pane is still present.
  // When moving rightward, account for the vacated slot so the final order matches the drop line.
  let desired = Math.max(0, Math.min(currentIds.length, Math.floor(index)));
  if (from < desired) desired -= 1;
  const next = currentIds.filter((id) => id !== sessionId);
  const insertAt = Math.max(0, Math.min(next.length, desired));
  next.splice(insertAt, 0, sessionId);
  return next;
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

/** Permanently delete durable Hermes sessions, then drop them from Studio lists. */
export async function deleteSessions(sessionIds: readonly string[]): Promise<{ deleted: string[]; failed: string[] }> {
  const targets = sessions.value.filter((session) => sessionIds.includes(session.id));
  if (targets.length === 0) return { deleted: [], failed: [] };

  const deleted: string[] = [];
  const failed: string[] = [];
  // Sequential deletes keep Hermes load predictable for bulk prune actions.
  for (const session of targets) {
    const storedId = session.storedSessionId ?? (session.remoteKind === "stored" ? session.id : undefined);
    if (!storedId) {
      deleted.push(session.id);
      continue;
    }
    try {
      await deleteStoredSession(session.profileId, storedId);
      deleted.push(session.id);
    } catch {
      failed.push(session.id);
    }
  }
  if (deleted.length > 0) dismissSessions(deleted);
  return { deleted, failed };
}

/**
 * Open or reuse a chat with the Kanban card's assignee for confirmation Q&A.
 * Does not change card status or call Hermes dispatch.
 */
export function askAssigneeAboutTask(
  task: import("./domain").WorkTask,
  options?: { openWorkspace?: boolean },
): string | undefined {
  const assigneeId = task.assigneeId;
  if (!assigneeId || task.pending) return undefined;
  const openWorkspace = options?.openWorkspace !== false;

  const existing = findCardAskSession(sessions.value, task.id, assigneeId);
  if (existing) {
    openSession(existing.id, openWorkspace ? undefined : { workspace: false });
    if (openWorkspace) openMobileWorkspace();
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
  if (openWorkspace) openMobileWorkspace();
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
