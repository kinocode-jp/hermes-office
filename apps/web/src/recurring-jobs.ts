import { signal } from "@preact/signals";
import type { ChatSession } from "./domain";

export const RECURRING_RETENTION_OPTIONS = [1, 3, 5, 10, 0] as const;
export type RecurringRetention = typeof RECURRING_RETENTION_OPTIONS[number];

const RETENTION_STORAGE_KEY = "hermes-studio.recurring-jobs.retention";
/** @deprecated session-id hide list. Migrated away in favor of job-key hide list. */
const HIDDEN_SESSION_STORAGE_KEY = "hermes-studio.recurring-jobs.hidden";
const HIDDEN_JOB_STORAGE_KEY = "hermes-studio.recurring-jobs.hidden-jobs.v1";

export const recurringJobRetention = signal<RecurringRetention>(loadRetention());
export const hiddenRecurringJobKeys = signal<Set<string>>(loadHiddenJobKeys());

export type RecurringJobGroup = {
  key: string;
  label: string;
  profileId: string;
  sessions: ChatSession[];
};

export function isRecurringJobSession(session: Pick<ChatSession, "title" | "titlePresentation">): boolean {
  if (session.titlePresentation === "new-chat") return false;
  // Prefer explicit job phrasing over bare words like "定期" alone, which appear in normal chats.
  return /(?:毎時(?:実行|ログ|ジョブ)?|定期(?:実行|ジョブ)|hourly(?:\s+(?:log|job|run|report))?|recurring(?:\s+job)?|\bcron(?:\s+job)?\b|scheduled\s+job)/iu.test(session.title);
}

export function isSuccessfulRecurringSession(session: Pick<ChatSession, "status" | "connectionState" | "errorMessage">): boolean {
  return session.status === "ready" && session.connectionState !== "error" && session.errorMessage === undefined;
}

export function recurringJobLabel(title: string): string {
  return title
    .replace(/\s*[·•|｜]\s*(?:[A-Z][a-z]{2}\s+\d{1,2}(?:\s+\d{1,2}:\d{2})?|\d{4}[-/]\d{1,2}[-/]\d{1,2}.*)$/iu, "")
    .replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/u, "")
    .trim() || title;
}

/** Stable family key so hide survives session id regeneration. */
export function recurringJobKey(profileId: string, title: string): string {
  return `${profileId}\0${recurringJobLabel(title)}`;
}

export function recurringJobGroups(sessions: readonly ChatSession[], includeHidden = false): RecurringJobGroup[] {
  const groups = new Map<string, RecurringJobGroup>();
  for (const session of sessions) {
    if (!isRecurringJobSession(session)) continue;
    const label = recurringJobLabel(session.title);
    const key = recurringJobKey(session.profileId, session.title);
    if (!includeHidden && isRecurringJobHidden(key)) continue;
    const current = groups.get(key);
    if (current) current.sessions.push(session);
    else groups.set(key, { key, label, profileId: session.profileId, sessions: [session] });
  }
  for (const group of groups.values()) group.sessions = sortNewestFirst(group.sessions);
  return [...groups.values()];
}

export function recurringSessionsToPrune(sessions: readonly ChatSession[], retention = recurringJobRetention.value): string[] {
  if (retention === 0) return [];
  return recurringJobGroups(sessions).flatMap((group) => {
    const successful = group.sessions.filter(isSuccessfulRecurringSession);
    return successful.slice(retention).map((session) => session.id);
  });
}

export function setRecurringJobRetention(value: number): void {
  const next = normalizeRetention(value);
  recurringJobRetention.value = next;
  try { window.localStorage.setItem(RETENTION_STORAGE_KEY, String(next)); } catch { /* Preferences may be blocked. */ }
}

export function hideRecurringJobs(jobKeys: readonly string[]): void {
  if (jobKeys.length === 0) return;
  const next = new Set(hiddenRecurringJobKeys.value);
  for (const key of jobKeys) {
    if (key) next.add(key);
  }
  hiddenRecurringJobKeys.value = next;
  persistHiddenJobKeys(next);
}

/** Hide recurring job families for the provided session ids (uses current sessions to resolve keys). */
export function hideRecurringSessions(sessionIds: readonly string[], allSessions: readonly ChatSession[] = []): void {
  if (sessionIds.length === 0) return;
  const wanted = new Set(sessionIds);
  const keys = allSessions
    .filter((session) => wanted.has(session.id) && isRecurringJobSession(session))
    .map((session) => recurringJobKey(session.profileId, session.title));
  hideRecurringJobs(keys);
}

export function isRecurringJobHidden(jobKey: string): boolean {
  return hiddenRecurringJobKeys.value.has(jobKey);
}

/** Convert legacy session-id hides into job-key hides using the current session list. */
export function migrateHiddenRecurringSessionIds(allSessions: readonly ChatSession[]): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(HIDDEN_SESSION_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      window.localStorage.removeItem(HIDDEN_SESSION_STORAGE_KEY);
      return;
    }
    const ids = new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
    if (ids.size === 0) {
      window.localStorage.removeItem(HIDDEN_SESSION_STORAGE_KEY);
      return;
    }
    const keys = allSessions
      .filter((session) => ids.has(session.id) && isRecurringJobSession(session))
      .map((session) => recurringJobKey(session.profileId, session.title));
    if (keys.length > 0) hideRecurringJobs(keys);
    window.localStorage.removeItem(HIDDEN_SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** @deprecated Session-id hides no longer suppress regenerated runs. */
export function isRecurringSessionHidden(_sessionId: string): boolean {
  return false;
}

function sortNewestFirst(sessions: readonly ChatSession[]): ChatSession[] {
  return sessions
    .map((session, index) => ({ session, index, time: sessionTime(session) }))
    .sort((left, right) => {
      if (left.time !== undefined && right.time !== undefined && left.time !== right.time) return right.time - left.time;
      if (left.time !== undefined) return -1;
      if (right.time !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ session }) => session);
}

function sessionTime(session: ChatSession): number | undefined {
  const value = session.updatedAt ?? session.createdAt;
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeRetention(value: number): RecurringRetention {
  return (RECURRING_RETENTION_OPTIONS as readonly number[]).includes(value)
    ? value as RecurringRetention
    : 3;
}

function loadRetention(): RecurringRetention {
  if (typeof window === "undefined") return 3;
  try {
    const stored = window.localStorage.getItem(RETENTION_STORAGE_KEY);
    return stored === null ? 3 : normalizeRetention(Number(stored));
  }
  catch { return 3; }
}

function loadHiddenJobKeys(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(HIDDEN_JOB_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
      }
    }
    // Drop obsolete session-id hide list so regenerated jobs are not half-hidden.
    window.localStorage.removeItem(HIDDEN_SESSION_STORAGE_KEY);
    return new Set();
  } catch {
    return new Set();
  }
}

function persistHiddenJobKeys(keys: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(HIDDEN_JOB_STORAGE_KEY, JSON.stringify([...keys]));
    window.localStorage.removeItem(HIDDEN_SESSION_STORAGE_KEY);
  } catch {
    // Preferences may be blocked.
  }
}
