import type { HermesProfileBackendAccess } from "./hermes-settings.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MODELS = 500;
const DEFAULT_MAX_PROVIDERS = 200;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:+@-]{0,255}$/;

/** Canonical Hermes reasoning_effort values Office may surface (never invent). */
export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffortValue = (typeof REASONING_EFFORT_VALUES)[number];

const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_VALUES);
const MAX_REASONING_EFFORTS = REASONING_EFFORT_VALUES.length;

export interface LiveModelOption {
  id: string;
  label: string;
  /**
   * Explicit effort levels published by Hermes for this model.
   * Omitted when Hermes did not enumerate levels (do not invent defaults).
   */
  reasoningEfforts?: ReasoningEffortValue[];
}

export interface LiveProviderOption {
  id: string;
  label: string;
  active: boolean;
}

/** Public Office DTO — never includes credentials, config values, or diagnostics. */
export interface LiveModelsCatalog {
  profile: string;
  providers: LiveProviderOption[];
  /** Selected provider used for the models list (active or requested). */
  provider: string;
  models: LiveModelOption[];
  refreshedAt: string;
}

export interface HermesModelsAdapterOptions {
  resolveProfileBackend(profile: string): Promise<HermesProfileBackendAccess>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxModels?: number;
  maxProviders?: number;
}

export interface HermesModelsAdapter {
  loadLiveCatalog(
    profile: string,
    provider?: string,
    loadOptions?: { forceRefresh?: boolean },
  ): Promise<LiveModelsCatalog>;
}

export class HermesModelsError extends Error {
  readonly code: "invalid_request" | "not_found" | "rejected" | "response_too_large" | "timed_out";

  constructor(code: HermesModelsError["code"], message: string) {
    super(message);
    this.name = "HermesModelsError";
    this.code = code;
  }
}

/** Soft cache for repeated panel opens (provider switch still goes live when provider changes). */
const CATALOG_CACHE_TTL_MS = 45_000;

type CatalogCacheEntry = { expiresAt: number; catalog: LiveModelsCatalog };

/**
 * Loads a profile-scoped live model catalog from Hermes via loopback sidecar.
 * Concurrent loads for the same profile+provider coalesce onto one flight.
 * Successful catalogs are retained briefly so reopening the model panel is cheap.
 */
export function createHermesModelsAdapter(options: HermesModelsAdapterOptions): HermesModelsAdapter {
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60_000);
  const maxResponseBytes = bounded(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 4_096, 8 * 1024 * 1024);
  const maxModels = bounded(options.maxModels, DEFAULT_MAX_MODELS, 1, 2_000);
  const maxProviders = bounded(options.maxProviders, DEFAULT_MAX_PROVIDERS, 1, 500);
  const flights = new Map<string, Promise<LiveModelsCatalog>>();
  const cache = new Map<string, CatalogCacheEntry>();

  return {
    loadLiveCatalog(
      profile: string,
      provider?: string,
      loadOptions?: { forceRefresh?: boolean },
    ): Promise<LiveModelsCatalog> {
      const validProfile = requiredProfile(profile);
      const requested = provider === undefined || provider.trim() === ""
        ? ""
        : requiredProvider(provider);
      const forceRefresh = loadOptions?.forceRefresh === true;
      const flightKey = `${validProfile}\0${requested}`;

      if (!forceRefresh) {
        const hit = cache.get(flightKey);
        if (hit !== undefined && hit.expiresAt > Date.now()) {
          return Promise.resolve(hit.catalog);
        }
      }

      const existing = flights.get(flightKey);
      if (existing !== undefined) return existing;

      const flight = loadCatalog(
        validProfile,
        requested,
        options.resolveProfileBackend,
        timeoutMs,
        maxResponseBytes,
        maxModels,
        maxProviders,
        forceRefresh,
      ).then((catalog) => {
        cache.set(flightKey, {
          expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
          catalog,
        });
        return catalog;
      }).finally(() => {
        if (flights.get(flightKey) === flight) flights.delete(flightKey);
      });
      flights.set(flightKey, flight);
      return flight;
    },
  };
}

async function loadCatalog(
  profile: string,
  requestedProvider: string,
  resolveProfileBackend: HermesModelsAdapterOptions["resolveProfileBackend"],
  timeoutMs: number,
  maxResponseBytes: number,
  maxModels: number,
  maxProviders: number,
  forceRefresh: boolean,
): Promise<LiveModelsCatalog> {
  const lease = await resolveProfileBackend(profile);
  try {
    const client = new ProfileModelsClient(normalizeBackend(lease), timeoutMs, maxResponseBytes);
    const { providers, activeProvider } = await loadProviderList(client, maxProviders);
    const selected = resolveSelectedProvider(requestedProvider, providers, activeProvider);

    let models: LiveModelOption[] = [];
    if (selected !== "") {
      models = await loadModelsForProvider(client, selected, maxModels, forceRefresh);
    }

    return {
      profile,
      providers: providers.map((item) => ({
        id: item.id,
        label: item.label,
        active: item.id === activeProvider || item.active,
      })),
      provider: selected,
      models,
      refreshedAt: new Date().toISOString(),
    };
  } finally {
    lease.release();
  }
}

async function loadProviderList(
  client: ProfileModelsClient,
  maxProviders: number,
): Promise<{ providers: LiveProviderOption[]; activeProvider: string }> {
  // Prefer the local/session catalog first (usually cached in Hermes).
  // Only fall through when the response has no real provider rows.
  const primary = await client.requestOptional("/api/models", "GET");
  let acc = extractProviders(primary, maxProviders);

  const fallbacks = [
    "/api/models?freshness=session_visit",
    "/api/providers",
    "/api/model/options?explicit_only=1",
  ] as const;
  for (const path of fallbacks) {
    if (acc.hasListedProviders) break;
    const raw = await client.requestOptional(path, "GET");
    acc = mergeProviderExtracts(acc, extractProviders(raw, maxProviders), maxProviders);
  }

  if (acc.activeProvider === "" && acc.providers.length > 0) {
    const info = await client.requestOptional("/api/model/info", "GET");
    const fromInfo = extractActiveProvider(info);
    if (fromInfo !== undefined) {
      acc = mergeProviderExtracts(
        acc,
        { providers: [], activeProvider: fromInfo, hasListedProviders: false },
        maxProviders,
      );
    }
  }

  return { providers: acc.providers, activeProvider: acc.activeProvider };
}

async function loadModelsForProvider(
  client: ProfileModelsClient,
  provider: string,
  maxModels: number,
  forceRefresh: boolean,
): Promise<LiveModelOption[]> {
  // Fast path: serve whatever Hermes already has in its live list.
  // POST /api/models/refresh often hits remote provider APIs and dominates latency.
  const fromLive = await tryLoadLiveModels(client, provider, maxModels);
  if (fromLive.length > 0 && !forceRefresh) return fromLive;

  if (forceRefresh || fromLive.length === 0) {
    try {
      await client.request("/api/models/refresh", "POST", { provider });
    } catch (error) {
      // Refresh is best-effort; continue to live/options when Hermes rejects unknown refresh.
      if (error instanceof HermesModelsError && error.code === "timed_out") throw error;
    }
    const afterRefresh = await tryLoadLiveModels(client, provider, maxModels);
    if (afterRefresh.length > 0) return afterRefresh;
  }

  // Fallback: curated models from options for this provider only (no extra parallel fan-out).
  try {
    const optionsPayload = await client.requestOptional(
      `/api/model/options?explicit_only=1`,
      "GET",
    );
    return extractModelsForProvider(optionsPayload, provider, maxModels);
  } catch {
    return fromLive;
  }
}

async function tryLoadLiveModels(
  client: ProfileModelsClient,
  provider: string,
  maxModels: number,
): Promise<LiveModelOption[]> {
  try {
    const live = await client.request(
      `/api/models/live?provider=${encodeURIComponent(provider)}`,
      "GET",
    );
    return extractLiveModels(live, maxModels);
  } catch (error) {
    if (error instanceof HermesModelsError && error.code === "timed_out") throw error;
    return [];
  }
}

function resolveSelectedProvider(
  requested: string,
  providers: readonly LiveProviderOption[],
  activeProvider: string,
): string {
  if (requested !== "") {
    if (providers.some((item) => item.id === requested)) return requested;
    // Allow explicit request even if Hermes list is empty/stale (user may still switch).
    return requested;
  }
  if (activeProvider !== "" && (providers.length === 0 || providers.some((item) => item.id === activeProvider))) {
    return activeProvider;
  }
  const marked = providers.find((item) => item.active);
  if (marked !== undefined) return marked.id;
  return providers[0]?.id ?? "";
}

/** Result of parsing a single Hermes provider-list surface. */
export type ProviderListExtract = {
  providers: LiveProviderOption[];
  activeProvider: string;
  /**
   * True when the payload included a provider array/list (even if every row
   * was filtered). False for active-only or empty/null payloads so discovery
   * can continue to the next Hermes endpoint.
   */
  hasListedProviders: boolean;
};

/** Exported for focused pure tests (safe public fields only). */
export function extractProviders(value: unknown, maxProviders: number): ProviderListExtract {
  if (value === undefined || value === null) {
    return { providers: [], activeProvider: "", hasListedProviders: false };
  }
  const activeFromRoot = extractActiveProvider(value) ?? "";
  const rows = collectProviderRows(value);
  const hasListedProviders = rows.length > 0;
  const providers: LiveProviderOption[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, maxProviders * 2)) {
    if (providers.length >= maxProviders) break;
    const option = normalizeProviderOption(row, activeFromRoot);
    if (option === undefined || seen.has(option.id)) continue;
    seen.add(option.id);
    providers.push(option);
  }
  let activeProvider = activeFromRoot;
  if (activeProvider === "") {
    activeProvider = providers.find((item) => item.active)?.id ?? "";
  }
  ensureActiveProviderRow(providers, activeProvider, maxProviders);
  return { providers, activeProvider, hasListedProviders };
}

/**
 * Merge two discovery results. Prefer a real listed catalog from `next` when
 * present; keep known active provider identity; dedupe by id.
 */
export function mergeProviderExtracts(
  base: ProviderListExtract,
  next: ProviderListExtract,
  maxProviders: number,
): ProviderListExtract {
  const activeProvider = next.activeProvider || base.activeProvider;
  let providers: LiveProviderOption[];
  let hasListedProviders: boolean;

  if (next.hasListedProviders) {
    // Fallback catalog wins as the primary list.
    const map = new Map<string, LiveProviderOption>();
    for (const item of next.providers) map.set(item.id, { ...item });
    providers = [...map.values()];
    hasListedProviders = true;
  } else if (base.hasListedProviders) {
    providers = base.providers.map((item) => ({ ...item }));
    hasListedProviders = true;
  } else {
    // Neither side listed real rows — merge injected/partial seeds (active-only).
    const map = new Map<string, LiveProviderOption>();
    for (const item of base.providers) map.set(item.id, { ...item });
    for (const item of next.providers) map.set(item.id, { ...item });
    providers = [...map.values()];
    hasListedProviders = false;
  }

  ensureActiveProviderRow(providers, activeProvider, maxProviders);
  if (providers.length > maxProviders) providers = providers.slice(0, maxProviders);
  return { providers, activeProvider, hasListedProviders };
}

function ensureActiveProviderRow(
  providers: LiveProviderOption[],
  activeProvider: string,
  maxProviders: number,
): void {
  if (activeProvider === "") return;
  const existing = providers.find((item) => item.id === activeProvider);
  if (existing !== undefined) {
    existing.active = true;
    return;
  }
  if (providers.length >= maxProviders) providers.pop();
  providers.unshift({
    id: activeProvider,
    label: activeProvider,
    active: true,
  });
}

/** Exported for focused pure tests. */
export function extractLiveModels(value: unknown, maxModels: number): LiveModelOption[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.models)
      ? value.models
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : isRecord(value) && Array.isArray(value.data)
          ? value.data
          : [];
  const capabilityMap = isRecord(value) && isRecord(value.capabilities) ? value.capabilities : undefined;

  const models: LiveModelOption[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, maxModels * 2)) {
    if (models.length >= maxModels) break;
    let option = normalizeModelOption(row);
    if (option === undefined || seen.has(option.id)) continue;
    if (option.reasoningEfforts === undefined && capabilityMap !== undefined) {
      const fromCaps = extractReasoningEfforts(capabilityMap[option.id]);
      if (fromCaps !== undefined) option = { ...option, reasoningEfforts: fromCaps };
    }
    seen.add(option.id);
    models.push(option);
  }
  return models;
}

/**
 * Pull explicit reasoning-effort enumerations from Hermes-shaped payloads.
 * Returns undefined when no safe enumeration is present (boolean flags alone are ignored).
 */
export function extractReasoningEfforts(source: unknown): ReasoningEffortValue[] | undefined {
  if (source === undefined || source === null) return undefined;
  if (typeof source === "string" || Array.isArray(source)) return normalizeEffortList(source);
  if (!isRecord(source)) return undefined;

  for (const key of [
    "reasoning_efforts",
    "reasoningEfforts",
    "supported_reasoning_efforts",
    "supportedReasoningEfforts",
    "reasoning_effort_options",
    "allowed_reasoning_efforts",
    "allowedReasoningEfforts",
  ] as const) {
    const list = normalizeEffortList(source[key]);
    if (list !== undefined) return list;
  }

  if (isRecord(source.reasoning)) {
    for (const key of ["levels", "allowed_options", "options", "efforts", "effort_levels", "values"] as const) {
      const list = normalizeEffortList(source.reasoning[key]);
      if (list !== undefined) return list;
    }
  }

  if (isRecord(source.supports)) {
    const list = normalizeEffortList(
      source.supports.reasoning_effort ?? source.supports.reasoning_efforts ?? source.supports.reasoningEfforts,
    );
    if (list !== undefined) return list;
  }

  if (isRecord(source.capabilities)) {
    const nested = extractReasoningEfforts(source.capabilities);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

function normalizeEffortList(value: unknown): ReasoningEffortValue[] | undefined {
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s|]+/).filter(Boolean)
      : [];
  if (items.length === 0) return undefined;
  const seen = new Set<string>();
  for (const item of items.slice(0, MAX_REASONING_EFFORTS * 2)) {
    if (typeof item !== "string") continue;
    const effort = item.trim().toLowerCase();
    if (!REASONING_EFFORT_SET.has(effort) || seen.has(effort)) continue;
    seen.add(effort);
  }
  const ordered = REASONING_EFFORT_VALUES.filter((effort) => seen.has(effort));
  return ordered.length > 0 ? ordered : undefined;
}

function extractModelsForProvider(value: unknown, provider: string, maxModels: number): LiveModelOption[] {
  if (!isRecord(value) || !Array.isArray(value.providers)) return [];
  for (const row of value.providers) {
    if (!isRecord(row)) continue;
    const id = sanitizeProvider(row.slug ?? row.id ?? row.provider ?? row.name);
    if (id !== provider) continue;
    const models = row.models;
    if (!Array.isArray(models)) return [];
    return extractLiveModels({
      models,
      ...(isRecord(row.capabilities) ? { capabilities: row.capabilities } : {}),
    }, maxModels);
  }
  return [];
}

function collectProviderRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["providers", "items", "data"] as const) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function normalizeProviderOption(value: unknown, activeFromRoot: string): LiveProviderOption | undefined {
  if (typeof value === "string") {
    const id = sanitizeProvider(value);
    return id === undefined ? undefined : { id, label: id, active: id === activeFromRoot };
  }
  if (!isRecord(value)) return undefined;
  const id = sanitizeProvider(value.id ?? value.slug ?? value.provider ?? value.name);
  if (id === undefined) return undefined;
  const label = sanitizeLabel(value.label ?? value.display_name ?? value.displayName ?? value.name ?? id) ?? id;
  const active = value.active === true
    || value.is_current === true
    || value.isCurrent === true
    || value.current === true
    || id === activeFromRoot;
  // Prefer configured local providers: skip explicit unconfigured/disabled rows unless active.
  if (!active && isExplicitlyUnavailableProvider(value)) return undefined;
  return { id, label, active };
}

/** True when Hermes marks a row as not ready for selection (unless it is active). */
function isExplicitlyUnavailableProvider(value: Record<string, unknown>): boolean {
  if (value.configured === false || value.is_configured === false || value.isConfigured === false) return true;
  if (value.enabled === false || value.available === false) return true;
  if (value.authenticated === false || value.is_authenticated === false) return true;
  return false;
}

function extractActiveProvider(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["provider", "active_provider", "activeProvider", "current_provider", "currentProvider"] as const) {
    const candidate = sanitizeProvider(value[key]);
    if (candidate !== undefined) return candidate;
  }
  if (isRecord(value.model)) {
    const nested = sanitizeProvider(value.model.provider);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function normalizeModelOption(value: unknown): LiveModelOption | undefined {
  if (typeof value === "string") {
    const id = sanitizeModelId(value);
    return id === undefined ? undefined : { id, label: id };
  }
  if (!isRecord(value)) return undefined;
  const id = sanitizeModelId(value.id ?? value.model ?? value.name ?? value.slug);
  if (id === undefined) return undefined;
  const label = sanitizeLabel(value.label ?? value.name ?? value.display_name ?? value.displayName ?? id) ?? id;
  const reasoningEfforts = extractReasoningEfforts(value);
  return {
    id,
    label,
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  };
}

interface NormalizedBackend {
  baseUrl: URL;
  sessionToken: string;
}

class ProfileModelsClient {
  constructor(
    private readonly backend: NormalizedBackend,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes: number,
  ) {}

  async request(path: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<unknown> {
    return await this.#fetch(path, method, body, false);
  }

  async requestOptional(path: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<unknown> {
    return await this.#fetch(path, method, body, true);
  }

  async #fetch(
    path: string,
    method: "GET" | "POST",
    body: Record<string, unknown> | undefined,
    optional: boolean,
  ): Promise<unknown> {
    const target = new URL(path, this.backend.baseUrl);
    if (
      target.origin !== this.backend.baseUrl.origin
      || !target.pathname.startsWith("/api/")
    ) {
      throw invalid("Hermes models path is invalid.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const response = await fetch(target, {
        method,
        headers: {
          Accept: "application/json",
          "X-Hermes-Session-Token": this.backend.sessionToken,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        // Auth must fail closed even on discovery paths.
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => undefined);
          throw rejected();
        }
        // Compatibility gaps (unknown query, missing route, method, not implemented).
        if (optional && isCompatibilityStatus(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          return undefined;
        }
        if (response.status === 404) throw new HermesModelsError("not_found", "Hermes model catalog was not found.");
        throw rejected();
      }
      const text = await readBoundedText(response, this.maxResponseBytes);
      if (text === "") return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // Incomplete/non-JSON discovery payloads fall through to the next source.
        if (optional) return undefined;
        throw rejected();
      }
    } catch (error) {
      if (error instanceof HermesModelsError) throw error;
      if (isAbortError(error)) throw new HermesModelsError("timed_out", "Hermes model catalog request timed out.");
      if (optional) return undefined;
      throw rejected();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Status codes that mean "try another Hermes models/providers surface" for discovery. */
function isCompatibilityStatus(status: number): boolean {
  return status === 400
    || status === 404
    || status === 405
    || status === 406
    || status === 422
    || status === 501;
}

function sanitizeProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!PROVIDER_PATTERN.test(trimmed) || containsSuspicious(trimmed)) return undefined;
  return trimmed;
}

function sanitizeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!MODEL_ID_PATTERN.test(trimmed) || containsSuspicious(trimmed)) return undefined;
  return trimmed;
}

function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  if (cleaned === "" || containsSuspicious(cleaned)) return undefined;
  return cleaned;
}

function containsSuspicious(value: string): boolean {
  return /api[_-]?key|secret|token|password|credential|authorization|bearer/i.test(value)
    || value.includes("\0");
}

function normalizeBackend(value: HermesProfileBackendAccess): NormalizedBackend {
  const baseUrl = value.baseUrl instanceof URL ? new URL(value.baseUrl) : new URL(value.baseUrl);
  if (
    baseUrl.protocol !== "http:"
    || baseUrl.username !== ""
    || baseUrl.password !== ""
    || baseUrl.pathname !== "/"
    || baseUrl.search !== ""
    || baseUrl.hash !== ""
    || !isLoopback(baseUrl.hostname)
  ) {
    throw invalid("Profile backend must be a credential-free loopback HTTP origin.");
  }
  if (value.sessionToken.length < 16 || value.sessionToken.length > 512 || value.sessionToken.includes("\0")) {
    throw invalid("Profile backend token is invalid.");
  }
  return { baseUrl, sessionToken: value.sessionToken };
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new HermesModelsError("response_too_large", "Hermes model catalog response was too large.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HermesModelsError("response_too_large", "Hermes model catalog response was too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function requiredProfile(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) {
    throw invalid("Profile name is invalid.");
  }
  return value;
}

function requiredProvider(value: string): string {
  const sanitized = sanitizeProvider(value);
  if (sanitized === undefined) throw invalid("Provider name is invalid.");
  return sanitized;
}

function invalid(message: string): HermesModelsError {
  return new HermesModelsError("invalid_request", message);
}

function rejected(): HermesModelsError {
  return new HermesModelsError("rejected", "Hermes model catalog is unavailable.");
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value)));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
