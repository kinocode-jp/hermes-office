import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  GLOBAL_SETTINGS_MAX_SKILLS,
  isGlobalContextWithinBudget,
} from "@hermes-office/protocol";
import { containsLikelySecret, redactSecrets } from "./secret-scrubber.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface HermesProfileBackendAccess {
  /** Credential-free loopback origin of a backend pinned to `profile`. */
  baseUrl: string | URL;
  sessionToken: string;
  /** Release exactly once after all requests for this operation have settled. */
  release(): void;
}

export interface HermesSettingsAdapterOptions {
  /**
   * Must resolve a process whose HERMES_HOME is the requested profile.
   * Hermes memory routes are process-scoped and cannot safely use ?profile=.
   * The adapter holds the returned lease until the whole public operation settles.
   */
  resolveProfileBackend(profile: string): Promise<HermesProfileBackendAccess>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxSkillContentBytes?: number;
}

export interface SkillSettingsDto {
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  provenance: "agent" | "bundled" | "hub" | "unknown";
  usage: number;
}

export interface SkillContentDto {
  name: string;
  content: string;
  redacted: boolean;
  revision: string;
}

export interface MemoryProviderDto {
  name: string;
  description: string;
  configured: boolean;
}

export interface MemoryStatusDto {
  activeProvider: string;
  providers: MemoryProviderDto[];
  builtin: {
    memoryBytes: number;
    userBytes: number;
    hasMemory: boolean;
    hasUser: boolean;
  };
}

export type MemoryFieldKind = "boolean" | "secret" | "select" | "text";

export interface MemoryProviderFieldDto {
  key: string;
  label: string;
  kind: MemoryFieldKind;
  description: string;
  required: boolean;
  isSet: boolean;
  /** Secret values are never returned. */
  value?: boolean | string;
  options: Array<{ value: string; label: string; description: string }>;
}

export interface MemoryProviderConfigDto {
  name: string;
  label: string;
  fields: MemoryProviderFieldDto[];
  revision: string;
}

export interface ProfileSoulDto {
  profile: string;
  content: string;
  exists: boolean;
  redacted: boolean;
  revision: string;
}

export interface ProfileAgentSettingsDto {
  profile: string;
  skills: SkillSettingsDto[];
  memory: MemoryStatusDto;
  soul: ProfileSoulDto;
}

export interface HermesSettingsAdapter {
  getProfileSettings(profile: string): Promise<ProfileAgentSettingsDto>;
  listSkills(profile: string): Promise<SkillSettingsDto[]>;
  setSkillEnabled(profile: string, name: string, enabled: boolean, expectedEnabled?: boolean): Promise<void>;
  getSkillContent(profile: string, name: string): Promise<SkillContentDto>;
  updateSkillContent(profile: string, name: string, content: string, expectedRevision?: string): Promise<void>;
  getMemoryStatus(profile: string): Promise<MemoryStatusDto>;
  setMemoryProvider(profile: string, provider: string, expectedProvider?: string): Promise<void>;
  getMemoryProviderConfig(profile: string, provider: string): Promise<MemoryProviderConfigDto>;
  updateMemoryProviderConfig(profile: string, provider: string, values: Record<string, boolean | string>, expectedRevision?: string): Promise<void>;
  resetBuiltinMemory(profile: string, target: "all" | "memory" | "user"): Promise<void>;
  getProfileSoul(profile: string): Promise<ProfileSoulDto>;
  updateProfileSoul(profile: string, content: string, expectedRevision?: string): Promise<void>;
}

export class HermesSettingsError extends Error {
  readonly code: "conflict" | "invalid_request" | "not_found" | "rejected" | "response_too_large" | "timed_out";
  constructor(code: HermesSettingsError["code"], message: string) {
    super(message);
    this.name = "HermesSettingsError";
    this.code = code;
  }
}

export function createHermesSettingsAdapter(options: HermesSettingsAdapterOptions): HermesSettingsAdapter {
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60_000);
  const maxResponseBytes = bounded(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 4_096, 8 * 1024 * 1024);
  const maxSkillContentBytes = bounded(options.maxSkillContentBytes, 256 * 1024, 1_024, 512 * 1024);

  const withClient = async <T>(profile: string, operation: (client: ProfileClient) => Promise<T>): Promise<T> => {
    const validProfile = requiredProfile(profile);
    const lease = await options.resolveProfileBackend(validProfile);
    try {
      const client = new ProfileClient(validProfile, normalizeBackend(lease), timeoutMs, maxResponseBytes);
      return await operation(client);
    } finally {
      lease.release();
    }
  };

  const adapter: HermesSettingsAdapter = {
    getProfileSettings: async (profile) => await withClient(profile, async (client) => {
      const [skills, memory, soul] = await Promise.all([
        listSkillsWith(client),
        memoryStatusWith(client),
        soulWith(client),
      ]);
      return { profile: client.profile, skills, memory, soul };
    }),
    listSkills: async (profile) => await withClient(profile, listSkillsWith),
    setSkillEnabled: async (profile, name, enabled, expectedEnabled) => await withClient(profile, async (client) => {
      const skill = requiredName(name, "skill");
      if (expectedEnabled !== undefined) {
        const current = (await listSkillsWith(client)).find((item) => item.name === skill);
        if (current === undefined) throw new HermesSettingsError("not_found", "Hermes skill was not found.");
        if (current.enabled !== expectedEnabled) throw conflict();
      }
      await client.request("/api/skills/toggle", "PUT", { name: skill, enabled });
    }),
    getSkillContent: async (profile, name) => await withClient(profile, async (client) =>
      await skillContentWith(client, requiredName(name, "skill"), maxSkillContentBytes)),
    updateSkillContent: async (profile, name, content, expectedRevision) => {
      if (Buffer.byteLength(content) > maxSkillContentBytes || content.includes("\0")) throw invalid("Skill content is invalid or too large.");
      if (containsLikelySecret(content)) throw invalid("Skill content appears to contain a secret. Store credentials through the dedicated secret channel.");
      await withClient(profile, async (client) => {
        const skill = requiredName(name, "skill");
        if (expectedRevision !== undefined) {
          const current = await skillContentWith(client, skill, maxSkillContentBytes);
          if (current.redacted || current.revision !== requiredRevision(expectedRevision)) throw conflict();
        }
        await client.request("/api/skills/content", "PUT", { name: skill, content });
      });
    },
    getMemoryStatus: async (profile) => await withClient(profile, memoryStatusWith),
    setMemoryProvider: async (profile, provider, expectedProvider) => await withClient(profile, async (client) => {
      const selected = requiredProvider(provider, true);
      if (expectedProvider !== undefined && (await memoryStatusWith(client)).activeProvider !== requiredProvider(expectedProvider, true)) throw conflict();
      await client.request("/api/memory/provider", "PUT", { provider: selected });
    }),
    getMemoryProviderConfig: async (profile, provider) => await withClient(profile, async (client) =>
      await providerConfigWith(client, requiredProvider(provider, false))),
    updateMemoryProviderConfig: async (profile, provider, values, expectedRevision) => await withClient(profile, async (client) => {
      const validProvider = requiredProvider(provider, false);
      const schema = await providerConfigWith(client, validProvider);
      if (expectedRevision !== undefined && schema.revision !== requiredRevision(expectedRevision)) throw conflict();
      const fields = new Map(schema.fields.map((field) => [field.key, field]));
      const clean: Record<string, boolean | string> = {};
      for (const [key, value] of Object.entries(values)) {
        const field = fields.get(key);
        if (field === undefined) throw invalid(`Unknown memory setting: ${key}`);
        if (field.kind === "secret") throw invalid("Secret memory fields require the dedicated secret channel.");
        if (typeof value !== "string" && typeof value !== "boolean") throw invalid(`Invalid memory setting: ${key}`);
        if (typeof value === "string" && (value.length > 8_192 || value.includes("\0") || containsLikelySecret(value))) throw invalid(`Invalid memory setting: ${key}`);
        clean[key] = value;
      }
      await client.request(`/api/memory/providers/${encodeURIComponent(validProvider)}/config?surface=declared`, "PUT", { values: clean });
    }),
    resetBuiltinMemory: async (profile, target) => {
      if (target !== "all" && target !== "memory" && target !== "user") throw invalid("Memory reset target is invalid.");
      await withClient(profile, async (client) => await client.request("/api/memory/reset", "POST", { target }));
    },
    getProfileSoul: async (profile) => await withClient(profile, soulWith),
    updateProfileSoul: async (profile, content, expectedRevision) => {
      if (Buffer.byteLength(content) > 256 * 1024 || content.includes("\0")) throw invalid("Profile identity is invalid or too large.");
      if (containsLikelySecret(content)) throw invalid("Profile identity appears to contain a secret.");
      await withClient(profile, async (client) => {
        if (expectedRevision !== undefined) {
          const current = await soulWith(client);
          if (current.redacted || current.revision !== requiredRevision(expectedRevision)) throw conflict();
        }
        await client.request(`/api/profiles/${encodeURIComponent(client.profile)}/soul`, "PUT", { content });
      });
    },
  };
  return adapter;
}

interface NormalizedBackend { baseUrl: URL; sessionToken: string }

class ProfileClient {
  constructor(
    readonly profile: string,
    private readonly backend: NormalizedBackend,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes: number,
  ) {}

  async request(path: string, method: "GET" | "POST" | "PUT", body?: Record<string, unknown>): Promise<unknown> {
    const target = new URL(path, this.backend.baseUrl);
    if (target.origin !== this.backend.baseUrl.origin || !target.pathname.startsWith("/api/")) throw invalid("Hermes settings path is invalid.");
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
        if (response.status === 404) throw new HermesSettingsError("not_found", "Hermes setting was not found.");
        throw new HermesSettingsError("rejected", "Hermes rejected the settings request.");
      }
      const text = await readBoundedText(response, this.maxResponseBytes);
      if (text === "") return {};
      try { return JSON.parse(text) as unknown; } catch { throw invalidBackend(); }
    } catch (error) {
      if (error instanceof HermesSettingsError) throw error;
      if (isAbortError(error)) throw new HermesSettingsError("timed_out", "Hermes settings request timed out.");
      throw new HermesSettingsError("rejected", "Unable to reach Hermes settings.");
    } finally {
      clearTimeout(timer);
    }
  }
}

async function listSkillsWith(client: ProfileClient): Promise<SkillSettingsDto[]> {
  const raw = await client.request("/api/skills", "GET");
  if (!Array.isArray(raw)) throw invalidBackend();
  return raw.slice(0, 1_000).flatMap((item): SkillSettingsDto[] => {
    if (!isRecord(item) || typeof item.name !== "string" || !NAME_PATTERN.test(item.name)) return [];
    return [{
      name: item.name,
      category: safeText(item.category, 120) ?? "uncategorized",
      description: redactSecrets(safeText(item.description, 2_000) ?? "").value,
      enabled: item.enabled === true,
      provenance: item.provenance === "agent" || item.provenance === "bundled" || item.provenance === "hub" ? item.provenance : "unknown",
      usage: Math.max(0, Math.trunc(finiteNumber(item.usage) ?? 0)),
    }];
  });
}

async function skillContentWith(client: ProfileClient, skill: string, maxBytes: number): Promise<SkillContentDto> {
  const raw = await client.request(`/api/skills/content?name=${encodeURIComponent(skill)}`, "GET");
  if (!isRecord(raw) || typeof raw.content !== "string") throw invalidBackend();
  const safe = redactSecrets(truncateUtf8(raw.content, maxBytes));
  return { name: skill, content: safe.value, redacted: safe.redacted, revision: revisionOf(raw.content) };
}

async function memoryStatusWith(client: ProfileClient): Promise<MemoryStatusDto> {
  const raw = await client.request("/api/memory", "GET");
  if (!isRecord(raw)) throw invalidBackend();
  const files = isRecord(raw.builtin_files) ? raw.builtin_files : {};
  const memoryBytes = safeBytes(files.memory);
  const userBytes = safeBytes(files.user);
  const providers = Array.isArray(raw.providers) ? raw.providers.slice(0, 100).flatMap((item): MemoryProviderDto[] => {
    if (!isRecord(item) || typeof item.name !== "string" || !PROVIDER_PATTERN.test(item.name)) return [];
    return [{ name: item.name, description: redactSecrets(safeText(item.description, 1_000) ?? "").value, configured: item.configured === true }];
  }) : [];
  return { activeProvider: safeProvider(raw.active), providers, builtin: { memoryBytes, userBytes, hasMemory: memoryBytes > 0, hasUser: userBytes > 0 } };
}

async function providerConfigWith(client: ProfileClient, provider: string): Promise<MemoryProviderConfigDto> {
  const raw = await client.request(`/api/memory/providers/${encodeURIComponent(provider)}/config?surface=declared`, "GET");
  if (!isRecord(raw)) throw invalidBackend();
  const fields = Array.isArray(raw.fields) ? raw.fields.slice(0, 100).flatMap((item): MemoryProviderFieldDto[] => {
    if (!isRecord(item) || typeof item.key !== "string" || !NAME_PATTERN.test(item.key)) return [];
    const kind = memoryFieldKind(item.kind);
    const options = Array.isArray(item.options) ? item.options.slice(0, 100).flatMap((option): MemoryProviderFieldDto["options"] => {
      if (!isRecord(option) || typeof option.value !== "string") return [];
      return [{ value: option.value.slice(0, 200), label: safeText(option.label, 200) ?? option.value.slice(0, 200), description: redactSecrets(safeText(option.description, 1_000) ?? "").value }];
    }) : [];
    const value = kind === "secret" ? undefined : safeFieldValue(item.value, kind);
    return [{ key: item.key, label: safeText(item.label, 200) ?? item.key, kind, description: redactSecrets(safeText(item.description, 1_000) ?? "").value, required: item.required === true, isSet: item.is_set === true, ...(value === undefined ? {} : { value }), options }];
  }) : [];
  const label = safeText(raw.label, 200) ?? provider;
  return { name: provider, label, fields, revision: revisionOf(JSON.stringify({ name: provider, label, fields })) };
}

async function soulWith(client: ProfileClient): Promise<ProfileSoulDto> {
  const raw = await client.request(`/api/profiles/${encodeURIComponent(client.profile)}/soul`, "GET");
  if (!isRecord(raw) || typeof raw.content !== "string") throw invalidBackend();
  const safe = redactSecrets(truncateUtf8(raw.content, 256 * 1024));
  return { profile: client.profile, content: safe.value, exists: raw.exists === true, redacted: safe.redacted, revision: revisionOf(raw.content) };
}

export interface OfficeGlobalSettingsDto {
  revision: number;
  sharedSkillsEnabled: boolean;
  sharedContextEnabled: boolean;
  skills: string[];
  context: string;
  updatedAt: string;
  skillSync: {
    state: "pending" | "ready";
    failures: Array<{ profile: string; skill: string; operation: "disable" | "enable" }>;
  };
}

export interface OfficeManagedSkill { profile: string; skill: string }
export interface OfficePendingSkillOverride extends OfficeManagedSkill {
  id: string;
  desiredEnabled: boolean;
  expectedEnabled: boolean;
  createdAt: string;
}
export interface OfficePendingGlobalSkillMutation extends OfficeManagedSkill {
  id: string;
  revision: number;
  desiredEnabled: boolean;
  expectedEnabled: boolean;
  createdAt: string;
}
export interface OfficeGlobalMaterializationState {
  settings: OfficeGlobalSettingsDto;
  managedSkills: OfficeManagedSkill[];
  skillOverrides: OfficeManagedSkill[];
  pendingSkillOverrides: OfficePendingSkillOverride[];
  pendingGlobalSkillMutations: OfficePendingGlobalSkillMutation[];
}

export interface OfficeGlobalSettingsStoreOptions {
  /** Testable storage boundary; throwing leaves the previous atomic state intact. */
  beforeWrite?: (state: OfficeGlobalMaterializationState) => Promise<void> | void;
}

export interface OfficeGlobalSettingsUpdate {
  expectedRevision: number;
  sharedSkillsEnabled?: boolean;
  sharedContextEnabled?: boolean;
  skills?: string[];
  context?: string;
}

/** Office-owned global inheritance store. Hermes has no global profile layer. */
export class OfficeGlobalSettingsStore {
  readonly #filePath: string;
  readonly #options: OfficeGlobalSettingsStoreOptions;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: OfficeGlobalSettingsStoreOptions = {}) {
    if (filePath.trim() === "" || filePath.includes("\0")) throw invalid("Global settings path is invalid.");
    this.#filePath = filePath;
    this.#options = options;
  }

  async read(): Promise<OfficeGlobalSettingsDto> {
    await this.#queue;
    return (await this.#readStateUnsafe()).settings;
  }

  async update(input: OfficeGlobalSettingsUpdate): Promise<OfficeGlobalSettingsDto> {
    const staged = await this.beginMaterialization(input);
    return await this.finishMaterialization(staged.settings.revision, staged.managedSkills, staged.skillOverrides, []);
  }

  async readMaterialization(): Promise<OfficeGlobalMaterializationState> {
    await this.#queue;
    return await this.#readStateUnsafe();
  }

  async beginMaterialization(input: OfficeGlobalSettingsUpdate): Promise<OfficeGlobalMaterializationState> {
    return await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.settings.revision) throw new HermesSettingsError("conflict", "Global settings changed; refresh before saving.");
      const settings = validateGlobal({
        revision: current.settings.revision + 1,
        sharedSkillsEnabled: input.sharedSkillsEnabled ?? current.settings.sharedSkillsEnabled,
        sharedContextEnabled: input.sharedContextEnabled ?? current.settings.sharedContextEnabled,
        skills: input.skills ?? current.settings.skills,
        context: input.context ?? current.settings.context,
        updatedAt: new Date().toISOString(),
        skillSync: { state: "pending", failures: [] },
      });
      const next = { ...current, settings };
      await this.#writeState(next);
      return next;
    });
  }

  async finishMaterialization(
    expectedRevision: number,
    managedSkills: OfficeManagedSkill[],
    skillOverrides: OfficeManagedSkill[],
    failures: OfficeGlobalSettingsDto["skillSync"]["failures"],
  ): Promise<OfficeGlobalSettingsDto> {
    return await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (current.settings.revision !== expectedRevision) throw new HermesSettingsError("conflict", "Global settings changed while skills were being synchronized.");
      const settings = validateGlobal({
        ...current.settings,
        skillSync: { state: failures.length === 0 ? "ready" : "pending", failures },
      });
      const next = { ...current, settings, managedSkills: validateManagedSkills(managedSkills), skillOverrides: validateManagedSkills(skillOverrides) };
      await this.#writeState(next);
      return settings;
    });
  }

  async markSkillOverride(profile: string, skill: string): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      const managedSkills = current.managedSkills.filter((item) => item.profile !== profile || item.skill !== skill);
      const key = `${profile}\0${skill}`;
      const skillOverrides = current.skillOverrides.some((item) => `${item.profile}\0${item.skill}` === key)
        ? current.skillOverrides
        : [...current.skillOverrides, { profile, skill }];
      const pendingSkillOverrides = current.pendingSkillOverrides.filter((item) => `${item.profile}\0${item.skill}` !== key);
      await this.#writeState({ ...current, managedSkills, skillOverrides, pendingSkillOverrides });
    });
  }

  async prepareSkillOverride(
    profile: string,
    skill: string,
    desiredEnabled: boolean,
    expectedEnabled: boolean,
  ): Promise<{ transaction: OfficePendingSkillOverride; existing: boolean }> {
    return await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      const validProfile = requiredProfile(profile);
      const validSkill = requiredName(skill, "managed skill");
      const existing = current.pendingSkillOverrides.find((item) => item.profile === validProfile && item.skill === validSkill);
      if (existing !== undefined) {
        if (existing.desiredEnabled !== desiredEnabled || existing.expectedEnabled !== expectedEnabled) {
          throw new HermesSettingsError("conflict", "A different Profile skill change is pending reconciliation.");
        }
        return { transaction: existing, existing: true };
      }
      const transaction: OfficePendingSkillOverride = {
        id: randomBytes(32).toString("base64url"),
        profile: validProfile,
        skill: validSkill,
        desiredEnabled,
        expectedEnabled,
        createdAt: new Date().toISOString(),
      };
      await this.#writeState({
        ...current,
        pendingSkillOverrides: [...current.pendingSkillOverrides, transaction],
      });
      return { transaction, existing: false };
    });
  }

  async commitSkillOverride(transaction: OfficePendingSkillOverride): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      const pending = current.pendingSkillOverrides.find((item) => item.id === transaction.id);
      const key = `${transaction.profile}\0${transaction.skill}`;
      if (pending === undefined) {
        if (current.skillOverrides.some((item) => `${item.profile}\0${item.skill}` === key)) return;
        throw new HermesSettingsError("conflict", "Profile skill ownership transaction is no longer current.");
      }
      if (pending.profile !== transaction.profile || pending.skill !== transaction.skill
        || pending.desiredEnabled !== transaction.desiredEnabled || pending.expectedEnabled !== transaction.expectedEnabled) {
        throw new HermesSettingsError("conflict", "Profile skill ownership transaction does not match durable state.");
      }
      const pendingKey = `${pending.profile}\0${pending.skill}`;
      const managedSkills = current.managedSkills.filter((item) => `${item.profile}\0${item.skill}` !== pendingKey);
      const skillOverrides = current.skillOverrides.some((item) => `${item.profile}\0${item.skill}` === pendingKey)
        ? current.skillOverrides
        : [...current.skillOverrides, { profile: pending.profile, skill: pending.skill }];
      await this.#writeState({
        ...current,
        managedSkills,
        skillOverrides,
        pendingSkillOverrides: current.pendingSkillOverrides.filter((item) => item.id !== transaction.id),
      });
    });
  }

  async abortSkillOverride(transaction: OfficePendingSkillOverride): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (!current.pendingSkillOverrides.some((item) => item.id === transaction.id)) return;
      await this.#writeState({
        ...current,
        pendingSkillOverrides: current.pendingSkillOverrides.filter((item) => item.id !== transaction.id),
      });
    });
  }

  async prepareGlobalSkillMutation(
    revision: number,
    profile: string,
    skill: string,
    desiredEnabled: boolean,
    expectedEnabled: boolean,
  ): Promise<{ transaction: OfficePendingGlobalSkillMutation; existing: boolean }> {
    return await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (current.settings.revision !== revision) throw new HermesSettingsError("conflict", "Global settings changed before skill mutation was prepared.");
      const validProfile = requiredProfile(profile);
      const validSkill = requiredName(skill, "managed skill");
      const existing = current.pendingGlobalSkillMutations.find((item) => item.profile === validProfile && item.skill === validSkill);
      if (existing !== undefined) {
        if (existing.revision !== revision || existing.desiredEnabled !== desiredEnabled || existing.expectedEnabled !== expectedEnabled) {
          throw new HermesSettingsError("conflict", "A different global skill mutation is pending reconciliation.");
        }
        return { transaction: existing, existing: true };
      }
      const transaction: OfficePendingGlobalSkillMutation = {
        id: randomBytes(32).toString("base64url"), revision, profile: validProfile, skill: validSkill,
        desiredEnabled, expectedEnabled, createdAt: new Date().toISOString(),
      };
      await this.#writeState({ ...current, pendingGlobalSkillMutations: [...current.pendingGlobalSkillMutations, transaction] });
      return { transaction, existing: false };
    });
  }

  async commitGlobalSkillMutation(transaction: OfficePendingGlobalSkillMutation): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      const pending = current.pendingGlobalSkillMutations.find((item) => item.id === transaction.id);
      if (pending === undefined) return;
      if (current.settings.revision !== pending.revision) throw new HermesSettingsError("conflict", "Global skill mutation revision is no longer current.");
      const key = `${pending.profile}\0${pending.skill}`;
      const managedSkills = pending.desiredEnabled
        ? (current.managedSkills.some((item) => `${item.profile}\0${item.skill}` === key) ? current.managedSkills : [...current.managedSkills, { profile: pending.profile, skill: pending.skill }])
        : current.managedSkills.filter((item) => `${item.profile}\0${item.skill}` !== key);
      await this.#writeState({
        ...current,
        managedSkills,
        pendingGlobalSkillMutations: current.pendingGlobalSkillMutations.filter((item) => item.id !== pending.id),
      });
    });
  }

  async abortGlobalSkillMutation(transaction: OfficePendingGlobalSkillMutation): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (!current.pendingGlobalSkillMutations.some((item) => item.id === transaction.id)) return;
      await this.#writeState({
        ...current,
        pendingGlobalSkillMutations: current.pendingGlobalSkillMutations.filter((item) => item.id !== transaction.id),
      });
    });
  }

  async #readStateUnsafe(): Promise<OfficeGlobalMaterializationState> {
    try {
      const text = await readFile(this.#filePath, "utf8");
      return validateGlobalState(JSON.parse(text) as unknown);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { settings: defaultGlobalSettings(), managedSkills: [], skillOverrides: [], pendingSkillOverrides: [], pendingGlobalSkillMutations: [] };
      if (error instanceof HermesSettingsError) throw error;
      throw new HermesSettingsError("rejected", "Global settings could not be read.");
    }
  }

  async #writeState(state: OfficeGlobalMaterializationState): Promise<void> {
    await this.#options.beforeWrite?.(state);
    await atomicWriteJson(this.#filePath, state.managedSkills.length === 0 && state.skillOverrides.length === 0 && state.pendingSkillOverrides.length === 0 && state.pendingGlobalSkillMutations.length === 0
      ? state.settings
      : {
          ...state.settings,
          managedSkills: state.managedSkills,
          skillOverrides: state.skillOverrides,
          pendingSkillOverrides: state.pendingSkillOverrides,
          pendingGlobalSkillMutations: state.pendingGlobalSkillMutations,
        });
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function validateGlobal(value: unknown): OfficeGlobalSettingsDto {
  if (!isRecord(value) || !Number.isInteger(value.revision) || (value.revision as number) < 0 || typeof value.sharedSkillsEnabled !== "boolean" || typeof value.sharedContextEnabled !== "boolean" || !Array.isArray(value.skills) || typeof value.context !== "string" || typeof value.updatedAt !== "string") throw new HermesSettingsError("rejected", "Global settings are invalid.");
  const skills = value.skills.map((item) => requiredName(item, "global skill"));
  if (skills.length > GLOBAL_SETTINGS_MAX_SKILLS || new Set(skills).size !== skills.length) throw invalid("Global skill selection is invalid.");
  if (!isGlobalContextWithinBudget(value.context) || containsLikelySecret(value.context)) throw invalid("Global context is invalid, too large, or contains a possible secret.");
  if (Number.isNaN(Date.parse(value.updatedAt))) throw new HermesSettingsError("rejected", "Global settings timestamp is invalid.");
  const sync = isRecord(value.skillSync) ? value.skillSync : { state: "ready", failures: [] };
  const state = sync.state === "pending" ? "pending" : "ready";
  const failures = Array.isArray(sync.failures) ? sync.failures.slice(0, 100).flatMap((item): OfficeGlobalSettingsDto["skillSync"]["failures"] => {
    if (!isRecord(item) || typeof item.profile !== "string" || !PROFILE_PATTERN.test(item.profile) || typeof item.skill !== "string" || !NAME_PATTERN.test(item.skill) || (item.operation !== "enable" && item.operation !== "disable")) return [];
    return [{ profile: item.profile, skill: item.skill, operation: item.operation }];
  }) : [];
  return { revision: value.revision as number, sharedSkillsEnabled: value.sharedSkillsEnabled, sharedContextEnabled: value.sharedContextEnabled, skills: [...skills], context: value.context, updatedAt: value.updatedAt, skillSync: { state, failures } };
}

function defaultGlobalSettings(): OfficeGlobalSettingsDto {
  return { revision: 0, sharedSkillsEnabled: true, sharedContextEnabled: true, skills: [], context: "", updatedAt: new Date(0).toISOString(), skillSync: { state: "ready", failures: [] } };
}

function validateGlobalState(value: unknown): OfficeGlobalMaterializationState {
  const settings = validateGlobal(value);
  const managed = isRecord(value) && Array.isArray(value.managedSkills) ? value.managedSkills : [];
  const overrides = isRecord(value) && Array.isArray(value.skillOverrides) ? value.skillOverrides : [];
  const pending = isRecord(value) && Array.isArray(value.pendingSkillOverrides) ? value.pendingSkillOverrides : [];
  const pendingGlobal = isRecord(value) && Array.isArray(value.pendingGlobalSkillMutations) ? value.pendingGlobalSkillMutations : [];
  return {
    settings,
    managedSkills: validateManagedSkills(managed),
    skillOverrides: validateManagedSkills(overrides),
    pendingSkillOverrides: validatePendingSkillOverrides(pending),
    pendingGlobalSkillMutations: validatePendingGlobalSkillMutations(pendingGlobal),
  };
}

function validatePendingGlobalSkillMutations(value: unknown[]): OfficePendingGlobalSkillMutation[] {
  if (value.length > 10_000) throw invalid("Pending global skill mutations are too large.");
  const result = value.map((item): OfficePendingGlobalSkillMutation => {
    if (!isRecord(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item.id)
      || !Number.isInteger(item.revision) || (item.revision as number) < 0
      || typeof item.desiredEnabled !== "boolean" || typeof item.expectedEnabled !== "boolean"
      || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt))) throw invalid("Pending global skill mutation is invalid.");
    return { id: item.id, revision: item.revision as number, profile: requiredProfile(item.profile), skill: requiredName(item.skill, "managed skill"), desiredEnabled: item.desiredEnabled, expectedEnabled: item.expectedEnabled, createdAt: item.createdAt };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length || new Set(result.map((item) => `${item.profile}\0${item.skill}`)).size !== result.length) throw invalid("Pending global skill mutations contain duplicates.");
  return result;
}

function validatePendingSkillOverrides(value: unknown[]): OfficePendingSkillOverride[] {
  if (value.length > 1_000) throw invalid("Pending Profile skill changes are too large.");
  const result = value.map((item): OfficePendingSkillOverride => {
    if (!isRecord(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item.id)
      || typeof item.desiredEnabled !== "boolean" || typeof item.expectedEnabled !== "boolean"
      || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt))) {
      throw invalid("Pending Profile skill change is invalid.");
    }
    return {
      id: item.id,
      profile: requiredProfile(item.profile),
      skill: requiredName(item.skill, "managed skill"),
      desiredEnabled: item.desiredEnabled,
      expectedEnabled: item.expectedEnabled,
      createdAt: item.createdAt,
    };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length
    || new Set(result.map((item) => `${item.profile}\0${item.skill}`)).size !== result.length) {
    throw invalid("Pending Profile skill changes contain duplicates.");
  }
  return result;
}

function validateManagedSkills(value: unknown[]): OfficeManagedSkill[] {
  if (value.length > 10_000) throw invalid("Global skill provenance is too large.");
  const result = value.map((item): OfficeManagedSkill => {
    if (!isRecord(item)) throw invalid("Global skill provenance is invalid.");
    return { profile: requiredProfile(item.profile), skill: requiredName(item.skill, "managed skill") };
  });
  const unique = new Set(result.map((item) => `${item.profile}\0${item.skill}`));
  if (unique.size !== result.length) throw invalid("Global skill provenance contains duplicates.");
  return result;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

function normalizeBackend(value: HermesProfileBackendAccess): NormalizedBackend {
  const baseUrl = value.baseUrl instanceof URL ? new URL(value.baseUrl) : new URL(value.baseUrl);
  if (baseUrl.protocol !== "http:" || baseUrl.username !== "" || baseUrl.password !== "" || baseUrl.pathname !== "/" || baseUrl.search !== "" || baseUrl.hash !== "" || !isLoopback(baseUrl.hostname)) throw invalid("Profile backend must be a credential-free loopback HTTP origin.");
  if (value.sessionToken.length < 16 || value.sessionToken.length > 512 || value.sessionToken.includes("\0")) throw invalid("Profile backend token is invalid.");
  return { baseUrl, sessionToken: value.sessionToken };
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw new HermesSettingsError("response_too_large", "Hermes settings response was too large."); }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HermesSettingsError("response_too_large", "Hermes settings response was too large."); }
    text += decoder.decode(value, { stream: true });
  }
}

function revisionOf(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function requiredRevision(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalid("Settings revision is invalid."); return value; }
function conflict(): HermesSettingsError { return new HermesSettingsError("conflict", "Hermes setting changed; refresh before saving."); }
function requiredProfile(value: unknown): string { if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) throw invalid("Profile name is invalid."); return value; }
function requiredName(value: unknown, label: string): string { if (typeof value !== "string" || !NAME_PATTERN.test(value)) throw invalid(`${label} name is invalid.`); return value; }
function requiredProvider(value: unknown, allowBuiltin: boolean): string { if (allowBuiltin && value === "") return ""; if (typeof value !== "string" || !PROVIDER_PATTERN.test(value)) throw invalid("Memory provider is invalid."); return value; }
function safeProvider(value: unknown): string { return typeof value === "string" && (value === "" || PROVIDER_PATTERN.test(value)) ? value : ""; }
function memoryFieldKind(value: unknown): MemoryFieldKind { return value === "boolean" || value === "secret" || value === "select" ? value : "text"; }
function safeFieldValue(value: unknown, kind: MemoryFieldKind): boolean | string | undefined { if (kind === "boolean") return typeof value === "boolean" ? value : undefined; return typeof value === "string" ? redactSecrets(value.slice(0, 8_192)).value : undefined; }
function safeText(value: unknown, max: number): string | undefined { return typeof value === "string" ? value.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : undefined; }
function safeBytes(value: unknown): number { const number = finiteNumber(value); return number === undefined ? 0 : Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number))); }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))); }
function truncateUtf8(value: string, limit: number): string { if (Buffer.byteLength(value) <= limit) return value; let end = Math.min(value.length, limit); while (end > 0 && Buffer.byteLength(value.slice(0, end)) > limit - 3) end = Math.floor(end * 0.9); while (end < value.length && Buffer.byteLength(value.slice(0, end + 1)) <= limit - 3) end += 1; return `${value.slice(0, end)}…`; }
function isLoopback(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"; }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
function isNodeError(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(message: string): HermesSettingsError { return new HermesSettingsError("invalid_request", message); }
function invalidBackend(): HermesSettingsError { return new HermesSettingsError("rejected", "Hermes returned an invalid settings response."); }
