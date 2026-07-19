import { signal } from "@preact/signals";

export const WORKSPACE_LAYOUT_STORAGE_KEY = "hermes-office:workspace-layout:v1";
export const WORKSPACE_LAYOUT_VERSION = 1;
export const WORKSPACE_RATIO_MIN = 0.18;
export const WORKSPACE_RATIO_MAX = 0.72;

export const workspacePlacements = ["top", "right", "bottom", "left"] as const;
export type WorkspacePlacement = (typeof workspacePlacements)[number];

export type WorkspaceLayoutPreferences = {
  version: typeof WORKSPACE_LAYOUT_VERSION;
  placement: WorkspacePlacement;
  ratio: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const defaultWorkspaceLayout: WorkspaceLayoutPreferences = {
  version: WORKSPACE_LAYOUT_VERSION,
  placement: "bottom",
  ratio: 0.38,
};

const initialWorkspaceLayout = readWorkspaceLayout();
export const workspacePlacement = signal<WorkspacePlacement>(initialWorkspaceLayout.placement);
export const workspaceRatio = signal(initialWorkspaceLayout.ratio);

export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayoutPreferences {
  if (!isPlainObject(value)) return { ...defaultWorkspaceLayout };
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "placement,ratio,version") return { ...defaultWorkspaceLayout };
  if (value.version !== WORKSPACE_LAYOUT_VERSION || !isWorkspacePlacement(value.placement)) {
    return { ...defaultWorkspaceLayout };
  }
  if (typeof value.ratio !== "number" || !Number.isFinite(value.ratio)) return { ...defaultWorkspaceLayout };
  return { version: WORKSPACE_LAYOUT_VERSION, placement: value.placement, ratio: clampRatio(value.ratio) };
}

export function readWorkspaceLayout(storage: StorageLike | null = availableStorage()): WorkspaceLayoutPreferences {
  if (!storage) return { ...defaultWorkspaceLayout };
  try {
    const stored = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    return stored === null ? { ...defaultWorkspaceLayout } : normalizeWorkspaceLayout(JSON.parse(stored));
  } catch {
    return { ...defaultWorkspaceLayout };
  }
}

export function setWorkspacePlacement(placement: WorkspacePlacement): void {
  workspacePlacement.value = placement;
  persistWorkspaceLayout();
}

export function setWorkspaceRatio(ratio: number): void {
  workspaceRatio.value = clampRatio(ratio);
  persistWorkspaceLayout();
}

export function resetWorkspaceLayout(storage: StorageLike | null = availableStorage()): boolean {
  workspacePlacement.value = defaultWorkspaceLayout.placement;
  workspaceRatio.value = defaultWorkspaceLayout.ratio;
  if (!storage) return false;
  try {
    storage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function persistWorkspaceLayout(storage: StorageLike | null = availableStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
      version: WORKSPACE_LAYOUT_VERSION,
      placement: workspacePlacement.value,
      ratio: workspaceRatio.value,
    } satisfies WorkspaceLayoutPreferences));
    return true;
  } catch {
    return false;
  }
}

export function clampWorkspaceRatio(
  ratio: number,
  placement: WorkspacePlacement,
  width: number,
  height: number,
  minimumPaneSize = 240,
): number {
  const available = placement === "left" || placement === "right" ? width : height;
  if (!Number.isFinite(available) || available <= 0) return clampRatio(ratio);
  const minimum = Math.min(0.5, minimumPaneSize / available);
  return Math.min(Math.max(clampRatio(ratio), Math.max(WORKSPACE_RATIO_MIN, minimum)), Math.min(WORKSPACE_RATIO_MAX, 1 - minimum));
}

export function oppositePlacement(placement: WorkspacePlacement): WorkspacePlacement {
  if (placement === "top") return "bottom";
  if (placement === "right") return "left";
  if (placement === "bottom") return "top";
  return "right";
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return defaultWorkspaceLayout.ratio;
  return Math.min(WORKSPACE_RATIO_MAX, Math.max(WORKSPACE_RATIO_MIN, ratio));
}

function isWorkspacePlacement(value: unknown): value is WorkspacePlacement {
  return typeof value === "string" && (workspacePlacements as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function availableStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
