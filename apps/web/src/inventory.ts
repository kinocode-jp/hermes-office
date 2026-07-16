import { signal } from "@preact/signals";
import type { ChatSession, OfficeInventoryPagination, OfficeSnapshot, OfficeSnapshotProfile, Profile } from "./domain";
import { isOfficeSnapshot, OfficeHttpError, officeFetchJson } from "./office-api";
import { storedSessionClientId } from "./session-identity";
import { applyOfficeSnapshot, profileList, sessions } from "./store";

type InventoryKind = "profiles" | "sessions";
type InventoryPage = {
  kind: InventoryKind;
  profiles: OfficeSnapshotProfile[];
  sessions: OfficeSnapshot["sessions"];
  pagination: OfficeInventoryPagination;
};
type InventoryLoadState = OfficeInventoryPagination & { loading: boolean; error?: string | undefined };

const emptyState: InventoryLoadState = { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0, loading: false };
export const profileInventoryState = signal<InventoryLoadState>({ ...emptyState });
export const sessionInventoryState = signal<InventoryLoadState>({ ...emptyState });
let inventoryServerUrl = "";

export function initializeInventory(snapshot: OfficeSnapshot, serverUrl: string): void {
  inventoryServerUrl = serverUrl;
  profileInventoryState.value = { ...snapshot.inventory.profiles, loading: false };
  sessionInventoryState.value = { ...snapshot.inventory.sessions, loading: false };
}

export async function loadMoreProfiles(): Promise<void> { await loadMore("profiles"); }
export async function loadMoreSessions(): Promise<void> { await loadMore("sessions"); }

async function loadMore(kind: InventoryKind, retriedAfterRefresh = false): Promise<void> {
  const stateSignal = kind === "profiles" ? profileInventoryState : sessionInventoryState;
  const current = stateSignal.value;
  if (current.loading || !current.hasMore || current.nextCursor === undefined || inventoryServerUrl === "") return;
  stateSignal.value = { ...current, loading: true, error: undefined };
  try {
    const query = new URLSearchParams({ kind, cursor: current.nextCursor, limit: "100" });
    const page = await officeFetchJson<unknown>(`/api/v1/inventory?${query}`, {}, inventoryServerUrl);
    if (!isInventoryPage(page, kind)) throw new Error("Office Serverの一覧ページに互換性がありません。");
    mergeInventoryPage(page);
    stateSignal.value = { ...page.pagination, loading: false };
  } catch (caught) {
    let error = caught;
    if (error instanceof OfficeHttpError && error.status === 409 && !retriedAfterRefresh) {
      try {
        const snapshot = await officeFetchJson<unknown>("/api/v1/snapshot", {}, inventoryServerUrl);
        if (!isOfficeSnapshot(snapshot)) throw new Error("Office Serverの一覧snapshotに互換性がありません。");
        applyOfficeSnapshot(snapshot, inventoryServerUrl);
        initializeInventory(snapshot, inventoryServerUrl);
        await loadMore(kind, true);
        return;
      } catch (refreshError) {
        error = refreshError;
      }
    }
    const message = error instanceof Error ? error.message : "一覧を取得できませんでした。";
    if (caught instanceof OfficeHttpError && caught.status === 409) {
      const { nextCursor: _staleCursor, ...withoutCursor } = current;
      stateSignal.value = { ...withoutCursor, hasMore: false, loading: false, error: message };
    } else {
      stateSignal.value = { ...current, loading: false, error: message };
    }
  }
}

export function mergeInventoryPage(page: InventoryPage): void {
  if (page.kind === "profiles") mergeProfiles(page.profiles);
  else mergeSessions(page.sessions);
}

function mergeProfiles(rows: OfficeSnapshotProfile[]): void {
  const existing = new Set(profileList.value.map((profile) => profile.id));
  const palette = ["#64b7a7", "#e07a55", "#d6a94f", "#8499c8", "#55d6be", "#f06a57"];
  const additions = rows.flatMap((live): Profile[] => {
    if (existing.has(live.id)) return [];
    existing.add(live.id);
    const index = existing.size - 1;
    return [{ id: live.id, name: live.name, role: "", status: activityToStatus(live.activity), color: palette[index % palette.length]!, sessions: live.activeSessionCount, taskCount: 0, memoryBytes: 0, memoryNote: "Hermes runtimeから読み取ったProfileです。", skills: [], inheritedSkills: [] }];
  });
  if (additions.length > 0) profileList.value = [...profileList.value, ...additions];
}

function mergeSessions(rows: OfficeSnapshot["sessions"]): void {
  const existing = new Set(sessions.value.flatMap((session) => session.remoteKind === "stored" ? [`${session.profileId}\0${session.storedSessionId ?? session.id}`] : []));
  const additions = rows.flatMap((live): ChatSession[] => {
    const key = `${live.profileId}\0${live.id}`;
    if (existing.has(key)) return [];
    existing.add(key);
    return [{ id: storedSessionClientId(live.profileId, live.id), storedSessionId: live.id, profileId: live.profileId, title: live.title, status: live.activity === "thinking" || live.activity === "using-tool" ? "streaming" : live.activity === "waiting-for-user" ? "waiting" : "ready", messages: [], connectionState: "disconnected", historyState: "unloaded", remoteKind: "stored", readOnly: true }];
  });
  if (additions.length === 0) return;
  sessions.value = [...sessions.value, ...additions];
  const counts = new Map<string, number>();
  for (const session of sessions.value) if (session.remoteKind === "stored") counts.set(session.profileId, (counts.get(session.profileId) ?? 0) + 1);
  profileList.value = profileList.value.map((profile) => ({ ...profile, sessions: Math.max(profile.sessions, counts.get(profile.id) ?? 0) }));
}

function isInventoryPage(value: unknown, kind: InventoryKind): value is InventoryPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<InventoryPage>;
  const pagination = page.pagination as Partial<OfficeInventoryPagination> | undefined;
  return page.kind === kind && Array.isArray(page.profiles) && Array.isArray(page.sessions)
    && typeof pagination?.returned === "number" && Number.isSafeInteger(pagination.returned)
    && typeof pagination.available === "number" && Number.isSafeInteger(pagination.available)
    && typeof pagination?.hasMore === "boolean" && typeof pagination.truncated === "boolean"
    && typeof pagination.partialFailures === "number" && Number.isSafeInteger(pagination.partialFailures)
    && (!pagination.hasMore || (typeof pagination.nextCursor === "string" && pagination.nextCursor.length <= 256));
}

function activityToStatus(activity: string): Profile["status"] {
  if (activity === "thinking" || activity === "using-tool") return "working";
  if (activity === "waiting-for-user") return "waiting";
  if (activity === "blocked" || activity === "error") return "blocked";
  return "idle";
}
