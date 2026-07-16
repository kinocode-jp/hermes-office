import { randomBytes } from "node:crypto";
import type {
  AgentActivity,
  ChatSessionSummary,
  OfficeInventoryKind,
  OfficeInventoryMetadata,
  OfficeInventoryPage,
  OfficeInventoryPagination,
  ProfileSummary,
} from "@hermes-office/protocol";

const UPSTREAM_PAGE_SIZE = 100;
const SNAPSHOT_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 20;
const MAX_SESSION_ROWS = UPSTREAM_PAGE_SIZE * MAX_SESSION_PAGES;
const MAX_PROFILE_ROWS = 2_000;
const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;
const INVENTORY_TIMEOUT_MS = 7_000;

export type HermesJsonResult = { value: unknown; bytes: number };
export type HermesInventoryRequester = (path: string, timeoutMs: number) => Promise<HermesJsonResult>;

type CollectionState = {
  rows: Record<string, unknown>[];
  total?: number;
  truncated: boolean;
  partialFailures: number;
};

export type CollectedHermesInventory = {
  profiles: ProfileSummary[];
  sessions: ChatSessionSummary[];
  profilesState: Omit<CollectionState, "rows">;
  sessionsState: Omit<CollectionState, "rows">;
};

/** Collects a bounded, ordered inventory from Hermes' real offset API. */
export async function collectHermesInventory(request: HermesInventoryRequester): Promise<CollectedHermesInventory> {
  const deadline = Date.now() + INVENTORY_TIMEOUT_MS;
  const budget = { bytes: 0 };
  const profilesResult = await collectProfiles(request, deadline, budget);
  const sessionsResult = await collectSessions(request, deadline, budget);
  const sessions = mapSessions(sessionsResult.rows);
  const profiles = mapProfiles(profilesResult.rows, sessions);
  return {
    profiles,
    sessions,
    profilesState: withoutRows(profilesResult, profiles.length),
    sessionsState: withoutRows(sessionsResult, sessions.length),
  };
}

async function collectProfiles(
  request: HermesInventoryRequester,
  deadline: number,
  budget: { bytes: number },
): Promise<CollectionState> {
  try {
    const result = await boundedRequest(request, "/api/profiles", deadline, budget);
    const source = recordArray(result, "profiles");
    const rows = dedupeRecords(source.slice(0, MAX_PROFILE_ROWS), (row) => readString(row, "name"));
    const incomplete = source.length > MAX_PROFILE_ROWS || rows.length < Math.min(source.length, MAX_PROFILE_ROWS);
    return {
      rows,
      total: source.length,
      truncated: incomplete,
      partialFailures: incomplete ? 1 : 0,
    };
  } catch {
    return { rows: [], truncated: true, partialFailures: 1 };
  }
}

async function collectSessions(
  request: HermesInventoryRequester,
  deadline: number,
  budget: { bytes: number },
): Promise<CollectionState> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const failedProfiles = new Set<string>();
  let offset = 0;
  let total: number | undefined;
  let truncated = false;
  let requestFailures = 0;

  for (let page = 0; page < MAX_SESSION_PAGES && rows.length < MAX_SESSION_ROWS; page += 1) {
    let value: unknown;
    try {
      value = await boundedRequest(
        request,
        `/api/profiles/sessions?limit=${UPSTREAM_PAGE_SIZE}&offset=${offset}&order=recent`,
        deadline,
        budget,
      );
    } catch {
      truncated = true;
      requestFailures += 1;
      break;
    }
    const pageRows = recordArray(value, "sessions");
    const reportedTotal = readNonNegativeInteger(value, "total");
    if (reportedTotal !== undefined) total = Math.max(total ?? 0, reportedTotal);
    for (const failure of recordArray(value, "errors")) {
      failedProfiles.add(readString(failure, "profile") ?? "unknown");
    }
    for (const row of pageRows) {
      const id = readString(row, "id");
      const profile = readString(row, "profile");
      if (id === undefined || profile === undefined) continue;
      const key = `${profile}\0${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      if (rows.length === MAX_SESSION_ROWS) break;
    }

    if (pageRows.length === 0) {
      if ((total ?? offset) > offset) { truncated = true; requestFailures += 1; }
      break;
    }
    offset += pageRows.length;
    const upstreamHasMore = total === undefined ? pageRows.length >= UPSTREAM_PAGE_SIZE : offset < total;
    if (!upstreamHasMore) break;
    if (page === MAX_SESSION_PAGES - 1 || rows.length === MAX_SESSION_ROWS) truncated = true;
  }

  if (total !== undefined && rows.length < Math.min(total, MAX_SESSION_ROWS) && !truncated) {
    truncated = true;
    requestFailures += 1;
  }
  if (failedProfiles.size > 0) truncated = true;
  return { rows, ...(total === undefined ? {} : { total }), truncated, partialFailures: failedProfiles.size + requestFailures };
}

async function boundedRequest(
  request: HermesInventoryRequester,
  path: string,
  deadline: number,
  budget: { bytes: number },
): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Hermes inventory deadline exceeded.");
  const result = await request(path, remaining);
  if (!Number.isSafeInteger(result.bytes) || result.bytes < 0 || budget.bytes + result.bytes > MAX_INVENTORY_BYTES) {
    throw new Error("Hermes inventory byte budget exceeded.");
  }
  budget.bytes += result.bytes;
  return result.value;
}

function withoutRows(state: CollectionState, mappedLength: number): Omit<CollectionState, "rows"> {
  const total = state.total === undefined ? undefined : Math.max(state.total, mappedLength);
  return {
    ...(total === undefined ? {} : { total }),
    truncated: state.truncated,
    partialFailures: state.partialFailures,
  };
}

export class HermesInventoryCache {
  #token = "";
  #profiles: ProfileSummary[] = [];
  #sessions: ChatSessionSummary[] = [];
  #profilesState: Omit<CollectionState, "rows"> = { truncated: false, partialFailures: 0 };
  #sessionsState: Omit<CollectionState, "rows"> = { truncated: false, partialFailures: 0 };

  replace(inventory: CollectedHermesInventory): { profiles: ProfileSummary[]; sessions: ChatSessionSummary[]; metadata: OfficeInventoryMetadata } {
    this.#token = randomBytes(12).toString("base64url");
    this.#profiles = inventory.profiles;
    this.#sessions = inventory.sessions;
    this.#profilesState = inventory.profilesState;
    this.#sessionsState = inventory.sessionsState;
    const profiles = this.#page("profiles", 0, SNAPSHOT_PAGE_SIZE);
    const sessions = this.#page("sessions", 0, SNAPSHOT_PAGE_SIZE);
    return { profiles: [...profiles.profiles], sessions: [...sessions.sessions], metadata: { profiles: profiles.pagination, sessions: sessions.pagination } };
  }

  page(kind: OfficeInventoryKind, cursor: string, limit: number): OfficeInventoryPage {
    const offset = decodeCursor(cursor, this.#token, kind);
    return this.#page(kind, offset, Math.min(100, Math.max(1, Math.trunc(limit))));
  }

  #page(kind: OfficeInventoryKind, offset: number, limit: number): OfficeInventoryPage {
    const rows = kind === "profiles" ? this.#profiles : this.#sessions;
    const state = kind === "profiles" ? this.#profilesState : this.#sessionsState;
    const window = rows.slice(offset, offset + limit);
    const nextOffset = offset + window.length;
    const hasMore = nextOffset < rows.length;
    const pagination: OfficeInventoryPagination = {
      returned: window.length,
      available: rows.length,
      ...(state.total === undefined ? {} : { total: state.total }),
      hasMore,
      truncated: state.truncated,
      partialFailures: state.partialFailures,
      ...(hasMore ? { nextCursor: encodeCursor(this.#token, kind, nextOffset) } : {}),
    };
    return {
      kind,
      profiles: kind === "profiles" ? window as ProfileSummary[] : [],
      sessions: kind === "sessions" ? window as ChatSessionSummary[] : [],
      pagination,
    };
  }
}

export class InventoryCursorError extends Error {}

function encodeCursor(token: string, kind: OfficeInventoryKind, offset: number): string {
  return Buffer.from(`v1:${token}:${kind}:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(value: string, token: string, kind: OfficeInventoryKind): number {
  if (value.length < 1 || value.length > 256) throw new InventoryCursorError("Inventory cursor is invalid.");
  let decoded: string;
  try { decoded = Buffer.from(value, "base64url").toString("utf8"); }
  catch { throw new InventoryCursorError("Inventory cursor is invalid."); }
  const match = /^v1:([A-Za-z0-9_-]{16}):(profiles|sessions):(0|[1-9][0-9]{0,6})$/.exec(decoded);
  if (match === null || match[1] !== token || match[2] !== kind) throw new InventoryCursorError("Inventory cursor is stale or invalid.");
  const offset = Number(match[3]);
  if (!Number.isSafeInteger(offset) || offset > MAX_SESSION_ROWS) throw new InventoryCursorError("Inventory cursor is invalid.");
  return offset;
}

function dedupeRecords(rows: Record<string, unknown>[], keyOf: (row: Record<string, unknown>) => string | undefined): Record<string, unknown>[] {
  const seen = new Set<string>();
  return rows.filter((row) => { const key = keyOf(row); if (key === undefined || seen.has(key)) return false; seen.add(key); return true; });
}

function mapProfiles(rows: Record<string, unknown>[], sessions: ChatSessionSummary[]): ProfileSummary[] {
  const activeCounts = new Map<string, number>();
  for (const session of sessions) if (session.activity !== "idle") activeCounts.set(session.profileId, (activeCounts.get(session.profileId) ?? 0) + 1);
  return rows.flatMap((row): ProfileSummary[] => {
    const name = readString(row, "name");
    if (name === undefined) return [];
    const active = activeCounts.get(name) ?? 0;
    return [{ id: name, name, avatarKey: name, activity: activity(row.gateway_running === true, active), activeSessionCount: active, inheritedSkillCount: 0, ownSkillCount: readNumber(row, "skill_count") ?? 0, revision: 1 }];
  });
}

function mapSessions(rows: Record<string, unknown>[]): ChatSessionSummary[] {
  return rows.flatMap((row): ChatSessionSummary[] => {
    const id = readString(row, "id");
    const profile = readString(row, "profile");
    if (id === undefined || profile === undefined) return [];
    const preview = readString(row, "preview");
    return [{ id, profileId: profile, title: readString(row, "title") || "Untitled session", activity: row.is_active === true ? "thinking" : "idle", createdAt: epochToIso(readNumber(row, "started_at")), updatedAt: epochToIso(readNumber(row, "last_active") ?? readNumber(row, "ended_at")), ...(preview === undefined ? {} : { lastMessagePreview: preview.slice(0, 240) }) }];
  });
}

function activity(gateway: boolean, active: number): AgentActivity { return active > 0 ? "thinking" : gateway ? "idle" : "offline"; }
function epochToIso(value: number | undefined): string { return new Date((value ?? Date.now() / 1_000) * 1_000).toISOString(); }
function recordArray(value: unknown, key: string): Record<string, unknown>[] { const rows = isRecord(value) ? value[key] : undefined; return Array.isArray(rows) ? rows.filter(isRecord) : []; }
function readString(value: unknown, key: string): string | undefined { const item = isRecord(value) ? value[key] : undefined; return typeof item === "string" ? item : undefined; }
function readNumber(value: unknown, key: string): number | undefined { const item = isRecord(value) ? value[key] : undefined; return typeof item === "number" && Number.isFinite(item) ? item : undefined; }
function readNonNegativeInteger(value: unknown, key: string): number | undefined { const item = readNumber(value, key); return item !== undefined && Number.isSafeInteger(item) && item >= 0 ? item : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
