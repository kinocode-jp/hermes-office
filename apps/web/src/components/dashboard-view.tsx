import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { chatSessionTitle, t } from "../i18n";
import {
  activeDashboard,
  dashboardEffectiveSizes,
  dashboardRowLayout,
  MAX_DASHBOARD_PANELS,
  movePanel,
  resetActiveDashboardSizes,
  setActiveDashboardSizes,
  type DashboardPanel,
  type DashboardPanelKind,
  type DashboardSizes,
} from "../dashboard-layout";
import { addDashboardPanel, closeDashboardPanel } from "../dashboard-actions";
import { profileList, sessions } from "../store";
import { profileDisplayName } from "../profile-names";
import { ChatPane } from "./chat-pane";
import { KanbanBoard } from "./kanban-board";
import { OfficeScene } from "./office-scene";
import { TeamsPanel } from "./teams-panel";
import { ScheduledSessionsPanel } from "./scheduled-sessions-panel";
import { ProfilesPanel } from "./profiles-panel";
import { CloseIcon } from "./icons";

const PANEL_DRAG_TYPE = "application/x-hermes-panel";
const SESSION_DRAG_TYPE = "application/x-hermes-session";
/** Minimum pane share of the resized axis. */
const MIN_FRACTION = 0.15;

type ResizeGesture = {
  pointerId: number;
  /** "col" adjusts two columns inside one row; "row" adjusts two rows. */
  axis: "col" | "row";
  row: number;
  /** Index of the first of the two adjacent tracks. */
  index: number;
  startCoordinate: number;
  /** Total px of the two adjacent tracks at gesture start. */
  spanPx: number;
  /** Fraction of the first track at gesture start (0..1 of the pair). */
  startShare: number;
  sizes: DashboardSizes;
};

export function panelKindLabel(kind: DashboardPanelKind): string {
  switch (kind) {
    case "chat": return t("dashboard.panel.chat");
    case "kanban": return t("nav.kanban");
    case "studio": return t("nav.office");
    case "teams": return t("nav.teams");
    case "scheduled": return t("nav.scheduled");
    case "profiles": return t("dashboard.panel.profiles");
  }
}

type DropTarget = { index: number };

export function DashboardView() {
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [mobile, setMobile] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 768px)").matches);
  const gestureRef = useRef<ResizeGesture | null>(null);
  const hostRef = useRef<HTMLElement>(null);
  const dashboard = activeDashboard.value;
  const panels = dashboard.panels;
  const layout = dashboardRowLayout(panels.length);
  const sizes = dashboardEffectiveSizes(dashboard);

  useEffect(() => {
    const end = () => setDropTarget(null);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, []);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 768px)");
    const sync = () => setMobile(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setDropTarget(null);
  }, [panels.map((panel) => panel.id).join("|")]);

  const showNote = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote(null), 2200);
  };

  const resolveDropIndex = (event: DragEvent, host: HTMLElement): number => {
    const slots = [...host.querySelectorAll<HTMLElement>(".dashboard-panel")];
    if (slots.length === 0) return 0;
    const x = event.clientX;
    const y = event.clientY;
    for (let i = 0; i < slots.length; i += 1) {
      const rect = slots[i]!.getBoundingClientRect();
      if (y < rect.top) return i;
      if (y <= rect.bottom && x < rect.left + rect.width / 2) return i;
    }
    return slots.length;
  };

  const onDragOver = (event: DragEvent) => {
    const types = event.dataTransfer?.types ? [...event.dataTransfer.types] : [];
    const relevant = types.includes(PANEL_DRAG_TYPE) || types.includes(SESSION_DRAG_TYPE) || types.includes("text/plain");
    if (!relevant || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes(PANEL_DRAG_TYPE) ? "move" : "copy";
    const index = resolveDropIndex(event, event.currentTarget);
    setDropTarget((current) => (current && current.index === index ? current : { index }));
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const host = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const index = host ? resolveDropIndex(event, host) : dropTarget?.index ?? panels.length;
    setDropTarget(null);
    const panelId = event.dataTransfer?.getData(PANEL_DRAG_TYPE);
    if (panelId) {
      movePanel(panelId, index);
      return;
    }
    const sessionId = event.dataTransfer?.getData(SESSION_DRAG_TYPE) || event.dataTransfer?.getData("text/plain");
    if (!sessionId || !sessions.value.some((session) => session.id === sessionId)) return;
    const existing = panels.find((panel) => panel.kind === "chat" && panel.sessionId === sessionId);
    if (existing) {
      movePanel(existing.id, index);
      return;
    }
    const result = addDashboardPanel("chat", { sessionId, index });
    if (result === "full") showNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
  };

  const cloneSizes = (source: DashboardSizes): DashboardSizes => ({
    count: source.count,
    rowFr: [...source.rowFr],
    colFr: source.colFr.map((row) => [...row]),
  });

  const beginResize = (axis: "col" | "row", row: number, index: number) => (event: PointerEvent) => {
    if (mobile || event.button !== 0 || gestureRef.current || !hostRef.current) return;
    event.preventDefault();
    const host = hostRef.current;
    const current = dashboardEffectiveSizes(activeDashboard.value);
    let spanPx: number;
    let startShare: number;
    if (axis === "row") {
      const rowElements = [...host.querySelectorAll<HTMLElement>(".dashboard-row")];
      const first = rowElements[index]?.getBoundingClientRect();
      const second = rowElements[index + 1]?.getBoundingClientRect();
      if (!first || !second) return;
      spanPx = first.height + second.height;
      startShare = first.height / spanPx;
    } else {
      const rowElement = [...host.querySelectorAll<HTMLElement>(".dashboard-row")][row];
      const cells = rowElement ? [...rowElement.querySelectorAll<HTMLElement>(":scope > .dashboard-panel")] : [];
      const first = cells[index]?.getBoundingClientRect();
      const second = cells[index + 1]?.getBoundingClientRect();
      if (!first || !second) return;
      spanPx = first.width + second.width;
      startShare = first.width / spanPx;
    }
    if (!(event.currentTarget instanceof HTMLElement)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      axis,
      row,
      index,
      startCoordinate: axis === "row" ? event.clientY : event.clientX,
      spanPx,
      startShare,
      sizes: cloneSizes(current),
    };
  };

  const moveResize = (event: PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId || gesture.spanPx <= 0) return;
    const delta = (gesture.axis === "row" ? event.clientY : event.clientX) - gesture.startCoordinate;
    const share = Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, gesture.startShare + delta / gesture.spanPx));
    const next = cloneSizes(gesture.sizes);
    if (gesture.axis === "row") {
      const pair = gesture.sizes.rowFr[gesture.index]! + gesture.sizes.rowFr[gesture.index + 1]!;
      next.rowFr[gesture.index] = pair * share;
      next.rowFr[gesture.index + 1] = pair * (1 - share);
    } else {
      const rowFractions = gesture.sizes.colFr[gesture.row]!;
      const pair = rowFractions[gesture.index]! + rowFractions[gesture.index + 1]!;
      next.colFr[gesture.row]![gesture.index] = pair * share;
      next.colFr[gesture.row]![gesture.index + 1] = pair * (1 - share);
    }
    setActiveDashboardSizes(next);
  };

  const finishResize = (event: PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const separatorProps = (axis: "col" | "row", row: number, index: number) => ({
    class: `dashboard-resize dashboard-resize--${axis}`,
    role: "separator" as const,
    "aria-orientation": (axis === "col" ? "vertical" : "horizontal") as "vertical" | "horizontal",
    "aria-label": t("dashboard.resize"),
    title: t("dashboard.resizeTitle"),
    draggable: false,
    onPointerDown: beginResize(axis, row, index),
    onPointerMove: moveResize,
    onPointerUp: finishResize,
    onPointerCancel: finishResize,
    onLostPointerCapture: finishResize,
    onDblClick: () => resetActiveDashboardSizes(),
    onDragStart: (event: DragEvent) => event.preventDefault(),
  });

  if (panels.length === 0) {
    return (
      <section class="dashboard-view is-empty" onDragOver={onDragOver} onDrop={onDrop}>
        <div class="dashboard-empty-copy">
          <b>{t("dashboard.empty")}</b>
          <small>{t("dashboard.emptyHint")}</small>
        </div>
        {note && <p class="workspace-drop-note">{note}</p>}
      </section>
    );
  }

  // Split panels into rows following the fixed layout (1-3 / 2+2 / 3+2 / 3+3).
  const rows: { panels: DashboardPanel[]; offset: number }[] = [];
  {
    let cursor = 0;
    for (const columns of layout) {
      rows.push({ panels: panels.slice(cursor, cursor + columns), offset: cursor });
      cursor += columns;
    }
  }

  const rowTemplate = sizes.rowFr
    .map((fr) => `minmax(0, ${round(fr)}fr)`)
    .join(" 1px ");

  return (
    <section
      ref={hostRef}
      class={`dashboard-view panels-${Math.min(panels.length, MAX_DASHBOARD_PANELS)} ${dropTarget ? "is-dropping" : ""}`}
      aria-label={t("dashboard.aria")}
      style={mobile ? undefined : { gridTemplateRows: rowTemplate }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {note && <p class="workspace-drop-note">{note}</p>}
      {rows.flatMap((row, rowIndex) => {
        const columnTemplate = sizes.colFr[rowIndex]!
          .map((fr) => `minmax(0, ${round(fr)}fr)`)
          .join(" 1px ");
        const rendered = [(
          <div
            key={`row-${rowIndex}`}
            class="dashboard-row"
            style={mobile ? undefined : { gridTemplateColumns: columnTemplate }}
          >
            {row.panels.flatMap((panel, columnIndex) => {
              const globalIndex = row.offset + columnIndex;
              const cells = [(
                <DashboardPanelFrame
                  key={panel.id}
                  panel={panel}
                  showDropBefore={dropTarget?.index === globalIndex}
                  showDropAfter={dropTarget?.index === panels.length && globalIndex === panels.length - 1}
                />
              )];
              if (!mobile && columnIndex < row.panels.length - 1) {
                cells.push(<div key={`col-sep-${rowIndex}-${columnIndex}`} {...separatorProps("col", rowIndex, columnIndex)} />);
              }
              return cells;
            })}
          </div>
        )];
        if (!mobile && rowIndex < rows.length - 1) {
          rendered.push(<div key={`row-sep-${rowIndex}`} {...separatorProps("row", 0, rowIndex)} />);
        }
        return rendered;
      })}
    </section>
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function DashboardPanelFrame({ panel, showDropBefore, showDropAfter }: {
  panel: DashboardPanel;
  showDropBefore: boolean;
  showDropAfter: boolean;
}) {
  const title = panelTitle(panel);
  return (
    <article
      class={`dashboard-panel dashboard-panel--${panel.kind} ${showDropBefore ? "has-drop-before" : ""} ${showDropAfter ? "has-drop-after" : ""}`}
      data-panel-id={panel.id}
    >
      {showDropBefore && <div class="workspace-drop-line" aria-hidden="true" />}
      <header
        class="dashboard-panel-head"
        draggable
        title={t("dashboard.dragPanel")}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer?.setData(PANEL_DRAG_TYPE, panel.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.add("is-dragging");
        }}
        onDragEnd={(event) => {
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.remove("is-dragging");
        }}
      >
        <b class="dashboard-panel-kind">{panelKindLabel(panel.kind)}</b>
        {title && <span class="dashboard-panel-title" title={title}>{title}</span>}
        <button
          class="icon-button dashboard-panel-close"
          type="button"
          draggable={false}
          aria-label={t("dashboard.closePanel", { label: panelKindLabel(panel.kind) })}
          title={t("dashboard.closePanel", { label: panelKindLabel(panel.kind) })}
          onPointerDown={(event) => event.stopPropagation()}
          onDragStart={(event) => event.preventDefault()}
          onClick={() => closeDashboardPanel(panel.id)}
        ><CloseIcon width={16} height={16} /></button>
      </header>
      <div class="dashboard-panel-body">
        <PanelContent panel={panel} />
      </div>
      {showDropAfter && <div class="workspace-drop-line is-after" aria-hidden="true" />}
    </article>
  );
}

function panelTitle(panel: DashboardPanel): string {
  if (panel.kind !== "chat" || !panel.sessionId) return "";
  const session = sessions.value.find((item) => item.id === panel.sessionId);
  if (!session) return "";
  const profile = profileList.value.find((item) => item.id === session.profileId);
  const name = profile ? profileDisplayName(profile) : session.profileId;
  return `${name} — ${chatSessionTitle(session)}`;
}

function PanelContent({ panel }: { panel: DashboardPanel }): ComponentChildren {
  if (panel.kind === "chat") {
    const session = sessions.value.find((item) => item.id === panel.sessionId);
    const profile = session ? profileList.value.find((item) => item.id === session.profileId) : undefined;
    if (!session || !profile) {
      return <p class="dashboard-panel-missing">{t("dashboard.chatMissing")}</p>;
    }
    return <ChatPane session={session} profile={profile} hideHeader onClosePane={() => closeDashboardPanel(panel.id)} />;
  }
  if (panel.kind === "kanban") return <KanbanBoard hideTitle />;
  if (panel.kind === "studio") return <OfficeScene profiles={profileList.value} embedded />;
  if (panel.kind === "teams") return <TeamsPanel hideTitle />;
  if (panel.kind === "profiles") return <ProfilesPanel />;
  return <ScheduledSessionsPanel hideTitle />;
}
