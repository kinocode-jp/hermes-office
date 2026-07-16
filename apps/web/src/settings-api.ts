import { officeFetchJson, type OfficeApiRequestOptions } from "./office-api";

export type SkillSettings = {
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  provenance: "agent" | "bundled" | "hub" | "unknown";
  usage: number;
};

export type SkillContent = {
  name: string;
  content: string;
  redacted: boolean;
  revision: string;
};

export type MemoryProvider = {
  name: string;
  description: string;
  configured: boolean;
};

export type MemoryStatus = {
  activeProvider: string;
  providers: MemoryProvider[];
  builtin: {
    memoryBytes: number;
    userBytes: number;
    hasMemory: boolean;
    hasUser: boolean;
  };
};

export type MemoryFieldKind = "boolean" | "secret" | "select" | "text";

export type MemoryProviderField = {
  key: string;
  label: string;
  kind: MemoryFieldKind;
  description: string;
  required: boolean;
  isSet: boolean;
  value?: boolean | string;
  options: Array<{ value: string; label: string; description: string }>;
};

export type MemoryProviderConfig = {
  name: string;
  label: string;
  fields: MemoryProviderField[];
  revision: string;
};

export type ProfileSoul = {
  profile: string;
  content: string;
  exists: boolean;
  redacted: boolean;
  revision: string;
};

export type ProfileAgentSettings = {
  profile: string;
  skills: SkillSettings[];
  memory: MemoryStatus;
  soul: ProfileSoul;
};

export type GlobalAgentSettings = {
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
};

export type GlobalSettingsUpdate = {
  expectedRevision: number;
  sharedSkillsEnabled?: boolean;
  sharedContextEnabled?: boolean;
  skills?: string[];
  context?: string;
};

export class SettingsApiError extends Error {
  constructor(
    readonly kind: "conflict" | "invalid" | "offline" | "unauthorized" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "SettingsApiError";
  }
}

export async function loadGlobalSettings(): Promise<GlobalAgentSettings> {
  return parseGlobalSettings(await settingsRequest<unknown>("/api/v1/settings/global"));
}

export async function updateGlobalSettings(update: GlobalSettingsUpdate): Promise<GlobalAgentSettings> {
  return parseGlobalSettings(await settingsRequest<unknown>("/api/v1/settings/global", { method: "PATCH", body: update }));
}

export async function loadProfileSettings(profile: string): Promise<ProfileAgentSettings> {
  return validateProfile(await settingsRequest<unknown>(profilePath(profile, "settings")));
}

export async function loadSkills(profile: string): Promise<SkillSettings[]> {
  const value = await settingsRequest<unknown>(profilePath(profile, "skills"));
  if (!Array.isArray(value)) throw incompatible();
  return value.map(validateSkill);
}

export async function setSkillEnabled(
  profile: string,
  skill: string,
  enabled: boolean,
  expectedEnabled: boolean,
): Promise<void> {
  await settingsRequest(profilePath(profile, `skills/${encodeSegment(skill)}`), {
    method: "PATCH",
    body: { enabled, expectedEnabled },
  });
}

export async function loadSkillContent(profile: string, skill: string): Promise<SkillContent> {
  return validateSkillContent(await settingsRequest<unknown>(profilePath(profile, `skills/${encodeSegment(skill)}/content`)));
}

export async function updateSkillContent(
  profile: string,
  skill: string,
  content: string,
  expectedRevision: string,
): Promise<SkillContent> {
  return validateSkillContent(await settingsRequest<unknown>(profilePath(profile, `skills/${encodeSegment(skill)}/content`), {
    method: "PUT", body: { content, expectedRevision },
  }));
}

export async function loadProfileSoul(profile: string): Promise<ProfileSoul> {
  return validateSoul(await settingsRequest<unknown>(profilePath(profile, "soul")));
}

export async function updateProfileSoul(profile: string, content: string, expectedRevision: string): Promise<ProfileSoul> {
  return validateSoul(await settingsRequest<unknown>(profilePath(profile, "soul"), {
    method: "PUT", body: { content, expectedRevision },
  }));
}

export async function loadMemoryStatus(profile: string): Promise<MemoryStatus> {
  return validateMemory(await settingsRequest<unknown>(profilePath(profile, "memory")));
}

export async function setMemoryProvider(
  profile: string,
  provider: string,
  expectedProvider: string,
): Promise<MemoryStatus> {
  return validateMemory(await settingsRequest<unknown>(profilePath(profile, "memory/provider"), {
    method: "PUT", body: { provider, expectedProvider },
  }));
}

export async function loadMemoryProviderConfig(profile: string, provider: string): Promise<MemoryProviderConfig> {
  return validateProviderConfig(await settingsRequest<unknown>(profilePath(profile, `memory/providers/${encodeSegment(provider)}`)));
}

export async function updateMemoryProviderConfig(
  profile: string,
  provider: string,
  values: Record<string, boolean | string>,
  expectedRevision: string,
): Promise<MemoryProviderConfig> {
  return validateProviderConfig(await settingsRequest<unknown>(profilePath(profile, `memory/providers/${encodeSegment(provider)}`), {
    method: "PATCH", body: { values, expectedRevision },
  }));
}

async function settingsRequest<T>(path: string, options: OfficeApiRequestOptions = {}): Promise<T> {
  try {
    // A cold profile settings read may lazily start `hermes --profile ... serve`.
    return await officeFetchJson<T>(path, { timeoutMs: 30_000, ...options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /HTTP\s+(\d{3})/.exec(message)?.[1];
    if (status === "409") throw new SettingsApiError("conflict", "別の画面で設定が更新されました。再読込してから変更してください。");
    if (status === "400" || status === "413" || status === "415") throw new SettingsApiError("invalid", "入力内容を確認してください。");
    if (status === "401" || status === "403") throw new SettingsApiError("unauthorized", "この設定を変更する権限がありません。");
    if (status === "502" || status === "503" || status === "504" || error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) throw new SettingsApiError("offline", "Hermes設定へ接続できません。runtimeを確認してください。");
    throw new SettingsApiError("unknown", "設定を読み込めませんでした。");
  }
}

function profilePath(profile: string, suffix: string): string { return `/api/v1/profiles/${encodeSegment(profile)}/${suffix}`; }
function encodeSegment(value: string): string { if (!value || value.includes("/") || value.includes("\0")) throw new SettingsApiError("invalid", "設定対象の名前が不正です。"); return encodeURIComponent(value); }

export function parseGlobalSettings(value: unknown): GlobalAgentSettings {
  if (!isRecord(value) || !Number.isInteger(value.revision) || typeof value.sharedSkillsEnabled !== "boolean" || typeof value.sharedContextEnabled !== "boolean" || !isStringArray(value.skills) || typeof value.context !== "string" || typeof value.updatedAt !== "string" || !isRecord(value.skillSync) || (value.skillSync.state !== "pending" && value.skillSync.state !== "ready") || !Array.isArray(value.skillSync.failures)) throw incompatible();
  const failures = value.skillSync.failures.map((item): GlobalAgentSettings["skillSync"]["failures"][number] => {
    if (!isRecord(item) || typeof item.profile !== "string" || typeof item.skill !== "string" || (item.operation !== "enable" && item.operation !== "disable")) throw incompatible();
    return { profile: item.profile, skill: item.skill, operation: item.operation };
  });
  return { revision: value.revision as number, sharedSkillsEnabled: value.sharedSkillsEnabled, sharedContextEnabled: value.sharedContextEnabled, skills: [...value.skills], context: value.context, updatedAt: value.updatedAt, skillSync: { state: value.skillSync.state, failures } };
}

function validateProfile(value: unknown): ProfileAgentSettings {
  if (!isRecord(value) || typeof value.profile !== "string" || !Array.isArray(value.skills)) throw incompatible();
  return { profile: value.profile, skills: value.skills.map(validateSkill), memory: validateMemory(value.memory), soul: validateSoul(value.soul) };
}

function validateSkill(value: unknown): SkillSettings {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.category !== "string" || typeof value.description !== "string" || typeof value.enabled !== "boolean" || typeof value.usage !== "number") throw incompatible();
  const provenance = value.provenance === "agent" || value.provenance === "bundled" || value.provenance === "hub" ? value.provenance : "unknown";
  return { name: value.name, category: value.category, description: value.description, enabled: value.enabled, provenance, usage: value.usage };
}

function validateSkillContent(value: unknown): SkillContent {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.content !== "string" || typeof value.redacted !== "boolean" || typeof value.revision !== "string") throw incompatible();
  return { name: value.name, content: value.content, redacted: value.redacted, revision: value.revision };
}

function validateMemory(value: unknown): MemoryStatus {
  if (!isRecord(value) || typeof value.activeProvider !== "string" || !Array.isArray(value.providers) || !isRecord(value.builtin)) throw incompatible();
  const providers = value.providers.map((item): MemoryProvider => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.description !== "string" || typeof item.configured !== "boolean") throw incompatible();
    return { name: item.name, description: item.description, configured: item.configured };
  });
  const builtin = value.builtin;
  if (typeof builtin.memoryBytes !== "number" || typeof builtin.userBytes !== "number" || typeof builtin.hasMemory !== "boolean" || typeof builtin.hasUser !== "boolean") throw incompatible();
  return { activeProvider: value.activeProvider, providers, builtin: { memoryBytes: builtin.memoryBytes, userBytes: builtin.userBytes, hasMemory: builtin.hasMemory, hasUser: builtin.hasUser } };
}

function validateSoul(value: unknown): ProfileSoul {
  if (!isRecord(value) || typeof value.profile !== "string" || typeof value.content !== "string" || typeof value.exists !== "boolean" || typeof value.redacted !== "boolean" || typeof value.revision !== "string") throw incompatible();
  return { profile: value.profile, content: value.content, exists: value.exists, redacted: value.redacted, revision: value.revision };
}

function validateProviderConfig(value: unknown): MemoryProviderConfig {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.label !== "string" || !Array.isArray(value.fields) || typeof value.revision !== "string") throw incompatible();
  const fields = value.fields.map((item): MemoryProviderField => {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.label !== "string" || typeof item.description !== "string" || typeof item.required !== "boolean" || typeof item.isSet !== "boolean" || !Array.isArray(item.options)) throw incompatible();
    const kind: MemoryFieldKind = item.kind === "boolean" || item.kind === "secret" || item.kind === "select" ? item.kind : "text";
    const options = item.options.map((option) => {
      if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string" || typeof option.description !== "string") throw incompatible();
      return { value: option.value, label: option.label, description: option.description };
    });
    const field: MemoryProviderField = { key: item.key, label: item.label, description: item.description, required: item.required, isSet: item.isSet, kind, options };
    if (typeof item.value === "string" || typeof item.value === "boolean") field.value = item.value;
    return field;
  });
  return { name: value.name, label: value.label, fields, revision: value.revision };
}

function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function incompatible(): SettingsApiError { return new SettingsApiError("unknown", "Office Serverの設定応答に互換性がありません。"); }
