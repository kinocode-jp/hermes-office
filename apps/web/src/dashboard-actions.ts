/**
 * Bridges dashboard panel state with the chat/session store.
 *
 * Design: the store's `openSessionIds` remains the source of truth for which
 * chat sessions are live (connection lifecycle, eviction, mobile routes all
 * already hang off it). The active dashboard mirrors it: every open session
 * gets a chat panel, and switching dashboards rewrites `openSessionIds` to
 * match the target dashboard's chat panels. dashboard-layout.ts stays pure
 * and never imports store.ts.
 */
import { effect } from "@preact/signals";
import {
  activeDashboard,
  addPanelToActiveDashboard,
  MAX_DASHBOARD_PANELS,
  movePanel,
  newPanelId,
  persistDashboards,
  reconcileChatPanels,
  removePanel,
  switchDashboard,
  dashboards,
  activeDashboardId,
  type AddPanelResult,
  type DashboardPanelKind,
} from "./dashboard-layout";
import { officeWindowOpen, setOfficeWindowOpen } from "./office-window";
import {
  activeSessionId,
  closeSession,
  openSession,
  openSessionIds,
  sessions,
} from "./store";

/** Guard so dashboard-initiated session changes do not re-enter the mirror effect. */
let switching = false;

/** Mirror `openSessionIds` into the active dashboard's chat panels. */
function mirrorOpenSessionsIntoActiveDashboard(): void {
  const open = openSessionIds.value;
  const dashboard = activeDashboard.value;
  const chatPanels = dashboard.panels.filter((panel) => panel.kind === "chat");
  const stale = chatPanels.filter((panel) => panel.sessionId === undefined || !open.includes(panel.sessionId));
  const missing = open.filter((sessionId) => !chatPanels.some((panel) => panel.sessionId === sessionId));
  if (stale.length === 0 && missing.length === 0) return;
  const panels = dashboard.panels.filter((panel) => !stale.includes(panel));
  const overflow: string[] = [];
  for (const sessionId of missing) {
    if (panels.length >= MAX_DASHBOARD_PANELS) {
      overflow.push(sessionId);
      continue;
    }
    panels.push({ id: newPanelId(), kind: "chat", sessionId });
  }
  dashboards.value = dashboards.value.map((item) =>
    item.id === dashboard.id ? { ...item, panels } : item);
  persistDashboards();
  if (overflow.length > 0) {
    // The dashboard is full: sessions that cannot get a panel are closed so
    // the store and the visible layout never diverge.
    switching = true;
    try {
      for (const sessionId of overflow) closeSession(sessionId);
    } finally {
      switching = false;
    }
  }
}

/** Add a panel to the active dashboard, wiring session and studio side effects. */
export function addDashboardPanel(kind: DashboardPanelKind, options?: { sessionId?: string; index?: number }): AddPanelResult {
  if (kind === "chat") {
    const sessionId = options?.sessionId;
    if (!sessionId || !sessions.value.some((session) => session.id === sessionId)) return "full";
    const already = activeDashboard.value.panels.some((panel) => panel.kind === "chat" && panel.sessionId === sessionId);
    if (!already && activeDashboard.value.panels.length >= MAX_DASHBOARD_PANELS) return "full";
    // openSession handles connection + eviction; the mirror effect adds the panel.
    openSession(sessionId, { workspace: true, ...(typeof options?.index === "number" ? { index: options.index } : {}) });
    mirrorOpenSessionsIntoActiveDashboard();
    if (typeof options?.index === "number") {
      const panel = activeDashboard.value.panels.find((item) => item.kind === "chat" && item.sessionId === sessionId);
      if (panel) movePanel(panel.id, options.index);
    }
    return already ? "focused" : "added";
  }
  const result = addPanelToActiveDashboard(kind, options);
  if ((result === "added" || result === "focused") && kind === "studio") setOfficeWindowOpen(true);
  return result;
}

/** Close one panel; chat panels release their session via the store. */
export function closeDashboardPanel(panelId: string): void {
  const panel = activeDashboard.value.panels.find((item) => item.id === panelId);
  if (!panel) return;
  if (panel.kind === "chat" && panel.sessionId) {
    // closeSession updates openSessionIds; the mirror effect removes the panel.
    closeSession(panel.sessionId);
    mirrorOpenSessionsIntoActiveDashboard();
    return;
  }
  const removed = removePanel(panelId);
  if (!removed) return;
  if (removed.kind === "studio") setOfficeWindowOpen(false);
}

/** Switch dashboards, rewriting the open-session list to match the target. */
export function activateDashboard(dashboardId: string): void {
  const target = dashboards.value.find((dashboard) => dashboard.id === dashboardId);
  if (!target || dashboardId === activeDashboardId.value) return;
  const wanted = target.panels
    .filter((panel) => panel.kind === "chat" && panel.sessionId !== undefined
      && sessions.value.some((session) => session.id === panel.sessionId))
    .map((panel) => panel.sessionId!);
  switching = true;
  try {
    for (const id of openSessionIds.value.filter((sessionId) => !wanted.includes(sessionId))) closeSession(id);
    for (const id of wanted) openSession(id, { workspace: true });
  } finally {
    switching = false;
  }
  switchDashboard(dashboardId);
  if (target.panels.some((panel) => panel.kind === "studio")) setOfficeWindowOpen(true);
  mirrorOpenSessionsIntoActiveDashboard();
  if (!wanted.includes(activeSessionId.value)) activeSessionId.value = wanted.at(-1) ?? "";
}

let wiringInstalled = false;
let hadStudioPanel = false;
/** Chat panels restore only after the session list first loads. */
let restoredPersistedChats = false;

/** Install reactive wiring. Called once from app bootstrap; safe to re-call. */
export function installDashboardWiring(): () => void {
  if (wiringInstalled) return () => {};
  wiringInstalled = true;
  hadStudioPanel = activeDashboard.value.panels.some((panel) => panel.kind === "studio");

  // One-shot restore: reopen the active dashboard's persisted chat sessions
  // once the session list arrives. Stored-session client ids are stable
  // (`stored:<profile>:<id>`), so panels survive reloads on live servers.
  const disposeRestore = effect(() => {
    const list = sessions.value;
    if (restoredPersistedChats || list.length === 0) return;
    restoredPersistedChats = true;
    const wanted = activeDashboard.value.panels
      .filter((panel) => panel.kind === "chat" && panel.sessionId !== undefined
        && list.some((session) => session.id === panel.sessionId))
      .map((panel) => panel.sessionId!);
    switching = true;
    try {
      for (const id of wanted) openSession(id, { workspace: true });
    } finally {
      switching = false;
    }
    mirrorOpenSessionsIntoActiveDashboard();
  });

  // Mirror the store's open sessions into the active dashboard (new chats,
  // closes, evictions, demo bootstrap all flow through openSessionIds).
  const disposeMirror = effect(() => {
    void openSessionIds.value;
    if (switching) return;
    // Before restore, an empty open list must not wipe persisted chat panels.
    if (!restoredPersistedChats && openSessionIds.value.length === 0) return;
    mirrorOpenSessionsIntoActiveDashboard();
  });

  // Drop chat panels (on any dashboard) whose sessions were deleted.
  const disposeReconcile = effect(() => {
    const list = sessions.value;
    if (list.length === 0) return;
    reconcileChatPanels(new Set(list.map((session) => session.id)));
  });

  // OfficeScene's own close button clears officeWindowOpen; mirror that to the panel.
  const disposeOffice = effect(() => {
    const open = officeWindowOpen.value;
    const panel = activeDashboard.value.panels.find((item) => item.kind === "studio");
    if (!open && panel && hadStudioPanel) removePanel(panel.id);
    hadStudioPanel = activeDashboard.value.panels.some((item) => item.kind === "studio");
  });

  return () => {
    disposeRestore();
    disposeMirror();
    disposeReconcile();
    disposeOffice();
    wiringInstalled = false;
  };
}
