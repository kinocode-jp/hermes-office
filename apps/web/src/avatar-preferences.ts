import { signal } from "@preact/signals";

const STORAGE_KEY = "hermes-office.profile-avatars.v1";
const CUSTOM_IMAGE_LIMIT = 1_500_000;
const DATABASE_NAME = "hermes-office-assets";
const DATABASE_STORE = "profile-avatars";
export const DEFAULT_CHARACTER_COUNT = 6;

export type ProfileAvatar =
  | { kind: "creature"; index: number }
  | { kind: "custom"; dataUrl: string };

type AvatarMap = Record<string, ProfileAvatar>;

const initialAvatars = readStoredAvatars();
export const profileAvatars = signal<AvatarMap>(initialAvatars);
void hydrateCustomAvatars(initialAvatars);

export function defaultAvatarOrdinal(profileId: string): number {
  const normalized = profileId.trim().toLocaleLowerCase("en-US");
  if (!normalized) return DEFAULT_CHARACTER_COUNT - 1;
  let hash = 2166136261;
  for (const character of normalized) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % DEFAULT_CHARACTER_COUNT;
}

export function defaultAvatarIndex(profileId: string): number {
  return defaultAvatarOrdinal(profileId) % DEFAULT_CHARACTER_COUNT;
}

export function avatarForProfile(profileId: string): ProfileAvatar {
  return profileAvatars.value[profileId] ?? { kind: "creature", index: defaultAvatarIndex(profileId) };
}

export function setCreatureAvatar(profileId: string, index: number): void {
  if (!profileId || !Number.isInteger(index) || index < 0 || index >= DEFAULT_CHARACTER_COUNT) return;
  updateAvatar(profileId, { kind: "creature", index });
  void deleteCustomAvatar(profileId);
}

export async function setCustomAvatar(profileId: string, dataUrl: string): Promise<boolean> {
  if (!profileId || !isSafeImageDataUrl(dataUrl) || dataUrl.length > CUSTOM_IMAGE_LIMIT) return false;
  if (!await writeCustomAvatar(profileId, dataUrl)) return false;
  updateAvatar(profileId, { kind: "custom", dataUrl });
  return true;
}

export function resetProfileAvatar(profileId: string): void {
  if (!(profileId in profileAvatars.value)) return;
  const next = { ...profileAvatars.value };
  delete next[profileId];
  profileAvatars.value = next;
  persist(next);
  void deleteCustomAvatar(profileId);
}

export function isSafeImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value);
}

function updateAvatar(profileId: string, avatar: ProfileAvatar): void {
  const next = { ...profileAvatars.value, [profileId]: avatar };
  profileAvatars.value = next;
  persist(next);
}

function readStoredAvatars(): AvatarMap {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const avatars: AvatarMap = {};
    for (const [profileId, value] of Object.entries(parsed)) {
      if (!profileId || !value || typeof value !== "object") continue;
      const avatar = value as Partial<ProfileAvatar>;
      if (avatar.kind === "creature" && Number.isInteger(avatar.index) && Number(avatar.index) >= 0) {
        // v1 offered twelve cells. Preserve old choices by folding them onto
        // the six production characters instead of discarding the preference.
        avatars[profileId] = { kind: "creature", index: Number(avatar.index) % DEFAULT_CHARACTER_COUNT };
        continue;
      }
      if (avatar.kind === "custom" && typeof avatar.dataUrl === "string" && avatar.dataUrl.length <= CUSTOM_IMAGE_LIMIT && isSafeImageDataUrl(avatar.dataUrl)) {
        avatars[profileId] = { kind: "custom", dataUrl: avatar.dataUrl };
      }
    }
    return avatars;
  } catch {
    return {};
  }
}

function persist(avatars: AvatarMap): void {
  try {
    const compact = Object.fromEntries(Object.entries(avatars).filter((entry): entry is [string, { kind: "creature"; index: number }] => entry[1].kind === "creature"));
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(compact));
  } catch {
    // Creature choices remain active for this session when preferences are blocked.
  }
}

async function hydrateCustomAvatars(initial: AvatarMap): Promise<void> {
  const database = await openAvatarDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(DATABASE_STORE, "readwrite");
    const store = transaction.objectStore(DATABASE_STORE);
    for (const [profileId, avatar] of Object.entries(initial)) {
      if (avatar.kind === "custom") store.put({ profileId, dataUrl: avatar.dataUrl });
    }
    const records = await requestResult<Array<{ profileId?: unknown; dataUrl?: unknown }>>(store.getAll());
    const next = { ...profileAvatars.value };
    for (const record of records) {
      if (typeof record.profileId !== "string" || typeof record.dataUrl !== "string") continue;
      if (next[record.profileId]?.kind === "creature") continue;
      if (record.dataUrl.length <= CUSTOM_IMAGE_LIMIT && isSafeImageDataUrl(record.dataUrl)) {
        next[record.profileId] = { kind: "custom", dataUrl: record.dataUrl };
      }
    }
    profileAvatars.value = next;
    persist(next);
  } catch {
    // Keep the light-weight creature defaults when asset storage is unavailable.
  } finally {
    database.close();
  }
}

async function writeCustomAvatar(profileId: string, dataUrl: string): Promise<boolean> {
  const database = await openAvatarDatabase();
  if (!database) return false;
  try {
    const transaction = database.transaction(DATABASE_STORE, "readwrite");
    await requestResult(transaction.objectStore(DATABASE_STORE).put({ profileId, dataUrl }));
    return true;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

async function deleteCustomAvatar(profileId: string): Promise<void> {
  const database = await openAvatarDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(DATABASE_STORE, "readwrite");
    await requestResult(transaction.objectStore(DATABASE_STORE).delete(profileId));
  } catch {
    // A creature/default choice in localStorage takes precedence over stale assets.
  } finally {
    database.close();
  }
}

function openAvatarDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DATABASE_STORE)) request.result.createObjectStore(DATABASE_STORE, { keyPath: "profileId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
}

function requestResult<T = IDBValidKey>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("avatar storage failed"));
  });
}
