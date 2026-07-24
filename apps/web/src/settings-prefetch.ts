import {
  loadAgentBehavior,
  loadGlobalSettings,
  loadProfileSettings,
  loadUsageStats,
  type AgentBehaviorSnapshot,
  type GlobalAgentSettings,
  type ProfileAgentSettings,
  type UsageStats,
} from "./settings-api";

export type PrefetchedProfileSettings = {
  profile: ProfileAgentSettings;
  behavior: AgentBehaviorSnapshot | null;
  usage: UsageStats | null;
  fetchedAt: number;
};

type CacheEntry<T> = {
  value?: T;
  error?: unknown;
  promise?: Promise<T> | undefined;
  fetchedAt: number;
};

const CORE_TTL_MS = 60_000;
const FETCH_GUARD_MS = 12_000;
const globalCache: { entry: CacheEntry<GlobalAgentSettings> | null } = { entry: null };
const profileCache = new Map<string, CacheEntry<PrefetchedProfileSettings>>();
let lastSelectedProfileId: string | null = null;

function isFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < CORE_TTL_MS;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readOrLoad<T>(
  current: CacheEntry<T> | null | undefined,
  loader: () => Promise<T>,
  force = false,
): Promise<{ entry: CacheEntry<T>; value: T }> {
  if (!force && current?.value !== undefined && isFresh(current.fetchedAt)) {
    return { entry: current, value: current.value };
  }
  if (!force && current?.promise) {
    // Reuse in-flight work, but never hang callers if the first request stalls.
    try {
      const value = await withTimeout(current.promise, FETCH_GUARD_MS + 1_000, "cached settings");
      return { entry: current, value };
    } catch (error) {
      // Fall through and start a fresh attempt.
    }
  }
  const entry: CacheEntry<T> = { fetchedAt: Date.now() };
  entry.promise = loader()
    .then((value) => {
      entry.value = value;
      entry.error = undefined;
      entry.fetchedAt = Date.now();
      entry.promise = undefined;
      return value;
    })
    .catch((error) => {
      entry.error = error;
      entry.promise = undefined;
      throw error;
    });
  const value = await entry.promise;
  return { entry, value };
}

export async function getCachedGlobalSettings(options?: { force?: boolean }): Promise<GlobalAgentSettings> {
  const { entry, value } = await readOrLoad(
    globalCache.entry,
    () => withTimeout(loadGlobalSettings(), FETCH_GUARD_MS, "global settings"),
    options?.force === true,
  );
  globalCache.entry = entry;
  return value;
}

export async function getCachedProfileCoreSettings(
  profileId: string,
  options?: { force?: boolean },
): Promise<PrefetchedProfileSettings> {
  const existing = profileCache.get(profileId) ?? null;
  const { entry, value } = await readOrLoad(
    existing,
    async () => {
      const profile = await withTimeout(loadProfileSettings(profileId), FETCH_GUARD_MS, `profile settings:${profileId}`);
      const [behaviorResult, usageResult] = await Promise.all([
        withTimeout(loadAgentBehavior(profileId), FETCH_GUARD_MS, `agent behavior:${profileId}`).then(
          (behavior) => ({ ok: true as const, behavior }),
          (reason: unknown) => ({ ok: false as const, reason }),
        ),
        withTimeout(loadUsageStats(profileId, 30), FETCH_GUARD_MS, `usage stats:${profileId}`).then(
          (usage) => ({ ok: true as const, usage }),
          (reason: unknown) => ({ ok: false as const, reason }),
        ),
      ]);
      return {
        profile,
        behavior: behaviorResult.ok ? behaviorResult.behavior : null,
        usage: usageResult.ok ? usageResult.usage : null,
        fetchedAt: Date.now(),
      } satisfies PrefetchedProfileSettings;
    },
    options?.force === true,
  );
  profileCache.set(profileId, entry);
  return value;
}

export function peekCachedGlobalSettings(): GlobalAgentSettings | null {
  const entry = globalCache.entry;
  if (!entry?.value || !isFresh(entry.fetchedAt)) return null;
  return entry.value;
}

export function peekCachedProfileCoreSettings(profileId: string): PrefetchedProfileSettings | null {
  const entry = profileCache.get(profileId);
  if (!entry?.value || !isFresh(entry.fetchedAt)) return null;
  return entry.value;
}

export function invalidateSettingsPrefetch(profileId?: string): void {
  if (!profileId) {
    globalCache.entry = null;
    profileCache.clear();
    return;
  }
  profileCache.delete(profileId);
}

async function prefetchCore(profileId: string | null): Promise<void> {
  try {
    await getCachedGlobalSettings();
  } catch {
    // Background warm-up must never throw into app boot.
  }
  if (!profileId) return;
  try {
    await getCachedProfileCoreSettings(profileId);
  } catch {
    // Ignore; opening settings will surface the error.
  }
}

/** Warm settings cache after Studio Server is ready. Safe to call repeatedly. */
export function ensureSettingsPrefetch(profileId: string | null): void {
  lastSelectedProfileId = profileId;
  void prefetchCore(profileId);
}

export function prefetchSelectedProfileSettings(profileId: string | null): void {
  if (!profileId) {
    lastSelectedProfileId = null;
    return;
  }
  if (profileId === lastSelectedProfileId && peekCachedProfileCoreSettings(profileId)) return;
  lastSelectedProfileId = profileId;
  void prefetchCore(profileId);
}
