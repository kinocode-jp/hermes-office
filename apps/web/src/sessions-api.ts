import { officeFetchJson } from "./office-api";

export async function deleteStoredSession(profileId: string, storedSessionId: string): Promise<void> {
  const profile = profileId.trim();
  const sessionId = storedSessionId.trim();
  if (!profile || !sessionId) throw new Error("Session identity is incomplete.");
  await officeFetchJson<{ ok: true }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(profile)}`,
    { method: "DELETE" },
  );
}
