import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { locale } from "../i18n";
import {
  WORKSPACE_RATIO_MAX,
  WORKSPACE_RATIO_MIN,
  clampWorkspaceRatio,
  oppositePlacement,
  persistWorkspaceLayout,
  setWorkspacePlacement,
  setWorkspaceRatio,
  workspaceChatPrecedesSurface,
  workspaceSeparatorKeyShortcuts,
  workspaceResizeRatioFromDelta,
  workspacePointerIsOwner,
  workspaceRatioBounds,
  workspacePlacement,
  workspacePlacements,
  workspaceRatio,
  type WorkspacePlacement,
  type WorkspaceRatioBounds,
} from "../workspace-layout";

type WorkspaceLayoutProps = {
  main: ComponentChildren;
  workspace: ComponentChildren;
  hasChats: boolean;
};

type DragSource = "office" | "chat";
type DockDrag = { source: DragSource; candidate: WorkspacePlacement; pointerId: number };
type ResizeGesture = {
  pointerId: number;
  startCoordinate: number;
  startRatio: number;
  placement: WorkspacePlacement;
  axisSize: number;
};

export function WorkspaceLayout({ main, workspace, hasChats }: WorkspaceLayoutProps) {
  const host = useRef<HTMLDivElement>(null);
  const ratioRef = useRef(workspaceRatio.value);
  const effectiveRatioRef = useRef(workspaceRatio.value);
  const resizingRef = useRef(false);
  const resizeGestureRef = useRef<ResizeGesture | null>(null);
  const dragRef = useRef<DockDrag | null>(null);
  const [mobile, setMobile] = useState(() => matchesMobile());
  const [effectiveRatio, setEffectiveRatio] = useState(workspaceRatio.value);
  const [effectiveBounds, setEffectiveBounds] = useState<WorkspaceRatioBounds>({
    min: WORKSPACE_RATIO_MIN,
    max: WORKSPACE_RATIO_MAX,
  });
  const [drag, setDrag] = useState<DockDrag | null>(null);
  const [layoutAnnouncement, setLayoutAnnouncement] = useState({ text: "", token: 0 });
  const placement = workspacePlacement.value;
  const preferredRatio = workspaceRatio.value;
  const isJapanese = locale.value === "ja";
  const copy = isJapanese ? {
    separator: (position: string) => `オフィスとチャットのサイズを変更（チャットは${position}）`,
    dockGroup: "ペインの配置を変更",
    officeHandle: "オフィス画面をドラッグして配置を変更",
    chatHandle: "チャット欄をドラッグして配置を変更",
    handleTitle: "端へドラッグ、またはAlt＋矢印キーで配置",
    placed: (position: string) => `チャットを${position}へ配置しました。`,
    dropZone: (source: DragSource, edge: string) => `${source === "office" ? "オフィス" : "チャット"}: ${edge}`,
  } : {
    separator: (position: string) => `Resize office and chat (chat is ${position})`,
    dockGroup: "Change pane placement",
    officeHandle: "Drag the office pane to change placement",
    chatHandle: "Drag the chat pane to change placement",
    handleTitle: "Drag to an edge, or use Alt+Arrow keys",
    placed: (position: string) => `Chat placed on the ${position}.`,
    dropZone: (source: DragSource, edge: string) => `${source === "office" ? "Office" : "Chat"}: ${edge}`,
  };

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 767px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  ratioRef.current = preferredRatio;
  effectiveRatioRef.current = effectiveRatio;

  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === "undefined") {
      setEffectiveRatio(ratioRef.current);
      return;
    }
    const update = () => {
      if (resizingRef.current) return;
      const rect = element.getBoundingClientRect();
      setEffectiveBounds(workspaceRatioBounds(placement, rect.width, rect.height));
      setEffectiveRatio(clampWorkspaceRatio(ratioRef.current, placement, rect.width, rect.height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [placement]);

  useEffect(() => {
    if (resizingRef.current) return;
    const rect = host.current?.getBoundingClientRect();
    setEffectiveBounds(rect
      ? workspaceRatioBounds(placement, rect.width, rect.height)
      : { min: WORKSPACE_RATIO_MIN, max: WORKSPACE_RATIO_MAX });
    setEffectiveRatio(rect
      ? clampWorkspaceRatio(preferredRatio, placement, rect.width, rect.height)
      : preferredRatio);
  }, [placement, preferredRatio]);

  const placementName = labelForPlacement(placement, isJapanese);
  const announcePlacement = (next: WorkspacePlacement) => {
    setLayoutAnnouncement((current) => ({
      text: copy.placed(labelForPlacement(next, isJapanese)),
      token: current.token + 1,
    }));
  };
  const commitDock = (next: WorkspacePlacement) => {
    setWorkspacePlacement(next);
    announcePlacement(next);
  };
  const releaseOwnedPointer = (event: PointerEvent) => {
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const finishResize = (event?: PointerEvent) => {
    const gesture = resizeGestureRef.current;
    if (event && !workspacePointerIsOwner(gesture?.pointerId ?? null, event.pointerId)) return;
    const shouldPersist = resizingRef.current || gesture !== null;
    resizeGestureRef.current = null;
    resizingRef.current = false;
    if (event) releaseOwnedPointer(event);
    if (shouldPersist) persistWorkspaceLayout();
  };
  const cancelDockDrag = (event?: PointerEvent) => {
    const current = dragRef.current;
    if (event && !workspacePointerIsOwner(current?.pointerId ?? null, event.pointerId)) return;
    dragRef.current = null;
    setDrag(null);
    if (event) releaseOwnedPointer(event);
  };
  const beginDockDrag = (source: DragSource, event: PointerEvent) => {
    if (mobile || !hasChats || event.button !== 0 || dragRef.current || resizeGestureRef.current) return;
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const next = { source, candidate: placement, pointerId: event.pointerId } satisfies DockDrag;
    dragRef.current = next;
    setDrag(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDockDrag = (event: PointerEvent) => {
    const current = dragRef.current;
    if (!current || !host.current || !workspacePointerIsOwner(current.pointerId, event.pointerId)) return;
    const next = { ...current, candidate: chatPlacementForEdge(current.source, closestEdge(host.current.getBoundingClientRect(), event.clientX, event.clientY)) };
    dragRef.current = next;
    setDrag(next);
  };
  const finishDockDrag = (event: PointerEvent) => {
    const current = dragRef.current;
    if (!current || !workspacePointerIsOwner(current.pointerId, event.pointerId)) return;
    dragRef.current = null;
    setDrag(null);
    releaseOwnedPointer(event);
    commitDock(current.candidate);
  };
  const beginResize = (event: PointerEvent) => {
    if (mobile || !hasChats || event.button !== 0 || !host.current || resizeGestureRef.current || dragRef.current) return;
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const rect = host.current.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeGestureRef.current = {
      pointerId: event.pointerId,
      startCoordinate: resizeAxisCoordinate(placement, event.clientX, event.clientY),
      startRatio: effectiveRatioRef.current,
      placement,
      axisSize: placement === "left" || placement === "right" ? rect.width : rect.height,
    };
    resizingRef.current = true;
  };
  const resize = (event: PointerEvent) => {
    const gesture = resizeGestureRef.current;
    if (mobile || !hasChats || !host.current || !gesture || event.pointerId !== gesture.pointerId) return;
    if (gesture.placement !== placement) {
      finishResize(event);
      return;
    }
    const rect = host.current.getBoundingClientRect();
    const raw = workspaceResizeRatioFromDelta(
      gesture.startRatio,
      gesture.startCoordinate,
      resizeAxisCoordinate(gesture.placement, event.clientX, event.clientY),
      gesture.placement,
      gesture.axisSize,
    );
    const next = clampWorkspaceRatio(raw, gesture.placement, rect.width, rect.height);
    setEffectiveBounds(workspaceRatioBounds(gesture.placement, rect.width, rect.height));
    setEffectiveRatio(next);
    workspaceRatio.value = next;
  };
  const resizeWithKeyboard = (event: KeyboardEvent) => {
    if (mobile || !hasChats || dragRef.current || resizeGestureRef.current) return;
    let next: number | undefined;
    if (event.key === "Home") next = effectiveBounds.min;
    if (event.key === "End") next = effectiveBounds.max;
    const growsWithKey = placement === "left" ? "ArrowRight"
      : placement === "right" ? "ArrowLeft"
      : placement === "top" ? "ArrowDown" : "ArrowUp";
    const shrinksWithKey = placement === "left" ? "ArrowLeft"
      : placement === "right" ? "ArrowRight"
      : placement === "top" ? "ArrowUp" : "ArrowDown";
    if (event.key === growsWithKey) next = effectiveRatio + 0.025;
    if (event.key === shrinksWithKey) next = effectiveRatio - 0.025;
    if (next === undefined) return;
    event.preventDefault();
    const rect = host.current?.getBoundingClientRect();
    const clamped = rect
      ? clampWorkspaceRatio(next, placement, rect.width, rect.height)
      : Math.min(effectiveBounds.max, Math.max(effectiveBounds.min, next));
    setEffectiveRatio(clamped);
    setWorkspaceRatio(clamped);
  };
  const dockWithKeyboard = (source: DragSource, event: KeyboardEvent) => {
    if (dragRef.current || resizeGestureRef.current) return;
    const edge = event.key === "ArrowUp" ? "top" : event.key === "ArrowRight" ? "right"
      : event.key === "ArrowDown" ? "bottom" : event.key === "ArrowLeft" ? "left" : null;
    if (!edge || (!event.altKey && !event.ctrlKey)) return;
    event.preventDefault();
    commitDock(chatPlacementForEdge(source, edge));
  };

  useEffect(() => {
    if (hasChats && !mobile) return;
    finishResize();
    cancelDockDrag();
  }, [hasChats, mobile]);

  useEffect(() => () => {
    const shouldPersist = resizingRef.current || resizeGestureRef.current !== null;
    resizeGestureRef.current = null;
    dragRef.current = null;
    resizingRef.current = false;
    if (shouldPersist) persistWorkspaceLayout();
  }, []);

  const surfacePane = <div key="surface-pane" class="workspace-layout-surface">{main}</div>;
  const chatPane = <div key="chat-pane" class="workspace-layout-chat">{workspace}</div>;
  const chatFirst = workspaceChatPrecedesSurface(placement, mobile, hasChats);
  const desktopDivider = hasChats && !mobile ? (
    <Fragment key="desktop-divider">
      <div
        class="workspace-separator"
        role="separator"
        tabIndex={0}
        aria-label={copy.separator(placementName)}
        aria-orientation={placement === "left" || placement === "right" ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(effectiveBounds.min * 100)}
        aria-valuemax={Math.round(effectiveBounds.max * 100)}
        aria-valuenow={Math.round(effectiveRatio * 100)}
        aria-keyshortcuts={workspaceSeparatorKeyShortcuts(placement)}
        onPointerDown={beginResize}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event); }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={(event) => finishResize(event)}
        onKeyDown={resizeWithKeyboard}
      />
      <div class="workspace-dock-controls" role="group" aria-label={copy.dockGroup}>
        <button
          type="button"
          class="workspace-dock-handle workspace-dock-handle--office"
          aria-label={copy.officeHandle}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowRight Alt+ArrowDown Alt+ArrowLeft"
          title={copy.handleTitle}
          onPointerDown={(event) => { event.stopPropagation(); beginDockDrag("office", event); }}
          onPointerMove={moveDockDrag}
          onPointerUp={finishDockDrag}
          onPointerCancel={cancelDockDrag}
          onLostPointerCapture={(event) => cancelDockDrag(event)}
          onKeyDown={(event) => dockWithKeyboard("office", event)}
        >O</button>
        <span aria-hidden="true" />
        <button
          type="button"
          class="workspace-dock-handle workspace-dock-handle--chat"
          aria-label={copy.chatHandle}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowRight Alt+ArrowDown Alt+ArrowLeft"
          title={copy.handleTitle}
          onPointerDown={(event) => { event.stopPropagation(); beginDockDrag("chat", event); }}
          onPointerMove={moveDockDrag}
          onPointerUp={finishDockDrag}
          onPointerCancel={cancelDockDrag}
          onLostPointerCapture={(event) => cancelDockDrag(event)}
          onKeyDown={(event) => dockWithKeyboard("chat", event)}
        >C</button>
      </div>
    </Fragment>
  ) : null;

  return (
    <div
      ref={host}
      class={`workspace-layout-host ${hasChats ? "has-chats" : "is-empty"} ${drag ? "is-docking" : ""}`}
      data-workspace-placement={placement}
      style={`--workspace-ratio: ${effectiveRatio * 100}%`}
    >
      {chatFirst && chatPane}
      {!chatFirst && surfacePane}
      {desktopDivider}
      {chatFirst && surfacePane}
      {!chatFirst && chatPane}
      <p class="visually-hidden" aria-live="polite" aria-atomic="true">
        {layoutAnnouncement.text}{layoutAnnouncement.token % 2 === 1 ? "\u200b" : ""}
      </p>
      {drag && hasChats && !mobile && (
        <div class="workspace-drop-zones" aria-hidden="true">
          {workspacePlacements.map((edge) => (
            <span key={edge} data-edge={edge} class={drag.candidate === chatPlacementForEdge(drag.source, edge) ? "is-target" : ""}>
              {copy.dropZone(drag.source, labelForPlacement(edge, isJapanese))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function chatPlacementForEdge(source: DragSource, edge: WorkspacePlacement): WorkspacePlacement {
  return source === "chat" ? edge : oppositePlacement(edge);
}

function closestEdge(rect: DOMRect, x: number, y: number): WorkspacePlacement {
  const distances: [WorkspacePlacement, number][] = [
    ["top", Math.abs(y - rect.top)],
    ["right", Math.abs(rect.right - x)],
    ["bottom", Math.abs(rect.bottom - y)],
    ["left", Math.abs(x - rect.left)],
  ];
  return distances.reduce((closest, candidate) => candidate[1] < closest[1] ? candidate : closest)[0];
}

function resizeAxisCoordinate(placement: WorkspacePlacement, x: number, y: number): number {
  return placement === "left" || placement === "right" ? x : y;
}

function labelForPlacement(placement: WorkspacePlacement, japanese: boolean): string {
  if (japanese) return placement === "top" ? "上" : placement === "right" ? "右" : placement === "bottom" ? "下" : "左";
  return placement;
}

function matchesMobile(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
}
