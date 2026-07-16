import type { ChatSession, OfficeSnapshot } from "./domain";

/** Stable browser-side identity for a Hermes session, whose raw ID is only profile-scoped. */
export function storedSessionClientId(profileId: string, storedSessionId: string): string {
  return `stored:${encodeURIComponent(profileId)}:${encodeURIComponent(storedSessionId)}`;
}

export function findStoredSession(
  current: readonly ChatSession[],
  live: OfficeSnapshot["sessions"][number],
): ChatSession | undefined {
  return current.find((session) => session.profileId === live.profileId
    && session.storedSessionId === live.id
    && session.remoteKind === "stored");
}
