import { officeFetchJson } from "./office-api";

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name.trim());
}

/** Create a Hermes profile (cloned from default's config/skills). */
export async function createHermesProfile(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!isValidProfileName(trimmed)) throw new Error("Profile name is invalid.");
  await officeFetchJson<{ ok: true }>("/api/v1/profiles", {
    method: "POST",
    body: { name: trimmed, cloneFromDefault: true },
  });
}

/** Permanently delete a Hermes profile and its local state. */
export async function deleteHermesProfile(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!isValidProfileName(trimmed) || trimmed === "default") throw new Error("Profile name is invalid.");
  await officeFetchJson<{ ok: true }>(`/api/v1/profiles/${encodeURIComponent(trimmed)}`, { method: "DELETE" });
}
