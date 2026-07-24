import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { HermesSettingsError } from "./hermes-settings.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PREFERRED_SUBAGENT_MAX_BYTES = 128;

export type SubagentMode = "auto" | "manual";

export interface SubagentModelChoice {
  provider: string;
  model: string;
  reasoningEffort: string;
}

export interface SharedSubagentCandidate {
  id: string;
  label: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  enabled: boolean;
}

export interface ProfileAgentBehaviorDto {
  profile: string;
  revision: number;
  subagentMode: SubagentMode;
  /** @deprecated Kept for older clients/seeds; derived from selected candidates. */
  preferredSubagent: string;
  /** Shared candidate ids selected for this profile, ordered by preference (max 3). */
  preferredCandidateIds: string[];
  updatedAt: string;
}

export interface OfficeAgentBehaviorUpdate {
  expectedRevision: number;
  subagentMode?: SubagentMode;
  preferredSubagent?: string;
  preferredCandidateIds?: string[];
  sharedCandidates?: SharedSubagentCandidate[];
}

export interface OfficeAgentBehaviorStoreOptions {
  /** Testable storage boundary; throwing leaves the previous atomic state intact. */
  beforeWrite?: (state: OfficeAgentBehaviorFileState) => Promise<void> | void;
}

export interface OfficeAgentBehaviorFileState {
  sharedCandidates: SharedSubagentCandidate[];
  profiles: Record<string, Omit<ProfileAgentBehaviorDto, "profile">>;
}

export interface AgentBehaviorSnapshot {
  sharedCandidates: SharedSubagentCandidate[];
  profile: ProfileAgentBehaviorDto;
}

/**
 * Office-owned per-profile agent behavior (subagent defaults).
 * Hermes has no subagent settings field; Office persists this layer itself
 * and injects a short system seed on new chat sessions when mode is "auto".
 */
export class OfficeAgentBehaviorStore {
  readonly #filePath: string;
  readonly #options: OfficeAgentBehaviorStoreOptions;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: OfficeAgentBehaviorStoreOptions = {}) {
    if (filePath.trim() === "" || filePath.includes("\0")) throw invalid("Agent behavior path is invalid.");
    this.#filePath = filePath;
    this.#options = options;
  }

  async read(profile: string): Promise<AgentBehaviorSnapshot> {
    await this.#queue;
    const name = requiredProfile(profile);
    const state = await this.#readStateUnsafe();
    return {
      sharedCandidates: state.sharedCandidates,
      profile: materialize(name, state.profiles[name], state.sharedCandidates),
    };
  }

  async update(profile: string, input: OfficeAgentBehaviorUpdate): Promise<AgentBehaviorSnapshot> {
    return await this.#mutate(async () => {
      const name = requiredProfile(profile);
      const state = await this.#readStateUnsafe();
      const current = materialize(name, state.profiles[name], state.sharedCandidates);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision) {
        throw new HermesSettingsError("conflict", "Agent behavior changed; refresh before saving.");
      }
      const sharedCandidates = input.sharedCandidates !== undefined
        ? validateSharedCandidates(input.sharedCandidates)
        : state.sharedCandidates;
      const preferredCandidateIds = input.preferredCandidateIds !== undefined
        ? validatePreferredCandidateIds(input.preferredCandidateIds, sharedCandidates)
        : sanitizePreferredCandidateIds(current.preferredCandidateIds, sharedCandidates);
      const preferredSubagent = input.preferredSubagent !== undefined
        ? validatePreferredSubagent(input.preferredSubagent)
        : derivePreferredSubagentLabel(preferredCandidateIds, sharedCandidates, current.preferredSubagent);
      const next: ProfileAgentBehaviorDto = {
        profile: name,
        revision: current.revision + 1,
        subagentMode: input.subagentMode ?? current.subagentMode,
        preferredSubagent,
        preferredCandidateIds,
        updatedAt: new Date().toISOString(),
      };
      validateBehavior(next, sharedCandidates);
      const profiles = {
        ...state.profiles,
        [name]: {
          revision: next.revision,
          subagentMode: next.subagentMode,
          preferredSubagent: next.preferredSubagent,
          preferredCandidateIds: next.preferredCandidateIds,
          updatedAt: next.updatedAt,
        },
      };
      await this.#writeState({ sharedCandidates, profiles });
      return { sharedCandidates, profile: next };
    });
  }

  /**
   * Returns a short system-seed instruction for `session.create` when the
   * profile prefers proactive subagents; otherwise `undefined`.
   */
  async sessionCreateInstruction(profile: string): Promise<string | undefined> {
    const snapshot = await this.read(profile);
    return buildSubagentSessionInstruction(snapshot.profile, snapshot.sharedCandidates);
  }

  async #readStateUnsafe(): Promise<OfficeAgentBehaviorFileState> {
    try {
      const text = await readFile(this.#filePath, "utf8");
      return validateFileState(JSON.parse(text) as unknown);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { sharedCandidates: [], profiles: {} };
      if (error instanceof HermesSettingsError) throw error;
      throw new HermesSettingsError("rejected", "Agent behavior settings could not be read.");
    }
  }

  async #writeState(state: OfficeAgentBehaviorFileState): Promise<void> {
    await this.#options.beforeWrite?.(state);
    await atomicWriteJson(this.#filePath, state);
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

/** Pure helper: system seed text when mode is auto; empty preferred name is omitted. */
export function buildSubagentSessionInstruction(
  behavior: Pick<ProfileAgentBehaviorDto, "subagentMode" | "preferredSubagent" | "preferredCandidateIds">,
  sharedCandidates: readonly SharedSubagentCandidate[] = [],
): string | undefined {
  if (behavior.subagentMode !== "auto") return undefined;
  const ordered = resolvePreferredCandidates(behavior.preferredCandidateIds, sharedCandidates);
  if (ordered.length > 0) {
    const lines = ordered.map((item, index) => {
      const effort = item.reasoningEffort.trim() || "default";
      const target = [item.provider, item.model].filter(Boolean).join("/") || item.label;
      return `${index + 1}. ${item.label} (${target}; reasoning=${effort})`;
    });
    return [
      "Use subagents proactively.",
      "When choosing a model for subagent work, try preferred candidates in order and automatically fall back to the next candidate if the current one is unavailable.",
      "Preferred subagent model candidates:",
      ...lines,
    ].join("\n");
  }
  const preferred = behavior.preferredSubagent.trim();
  if (preferred === "") return "Use subagents proactively.";
  return `Use subagents proactively. Preferred subagent: ${preferred}.`;
}

/** Join trusted Office system seeds for a new chat; returns undefined when empty. */
export function composeSessionCreateSystemSeed(
  ...parts: Array<string | undefined>
): string | undefined {
  const joined = parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join("\n\n");
  return joined === "" ? undefined : joined;
}

export function resolvePreferredCandidates(
  preferredCandidateIds: readonly string[],
  sharedCandidates: readonly SharedSubagentCandidate[],
): SharedSubagentCandidate[] {
  const byId = new Map(sharedCandidates.map((item) => [item.id, item]));
  const ordered: SharedSubagentCandidate[] = [];
  for (const id of preferredCandidateIds) {
    const item = byId.get(id);
    if (!item || !item.enabled) continue;
    ordered.push(item);
    if (ordered.length >= 3) break;
  }
  return ordered;
}

function materialize(
  profile: string,
  value: Omit<ProfileAgentBehaviorDto, "profile"> | undefined,
  sharedCandidates: readonly SharedSubagentCandidate[],
): ProfileAgentBehaviorDto {
  if (value === undefined) return defaultBehavior(profile);
  return validateBehavior({ profile, ...value }, sharedCandidates);
}

function defaultBehavior(profile: string): ProfileAgentBehaviorDto {
  return {
    profile,
    revision: 0,
    subagentMode: "manual",
    preferredSubagent: "",
    preferredCandidateIds: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function validateFileState(value: unknown): OfficeAgentBehaviorFileState {
  if (!isRecord(value) || !isRecord(value.profiles)) throw invalid("Agent behavior store is invalid.");
  const sharedCandidates = Array.isArray(value.sharedCandidates)
    ? validateSharedCandidates(value.sharedCandidates)
    : [];
  const profiles: OfficeAgentBehaviorFileState["profiles"] = {};
  for (const [key, item] of Object.entries(value.profiles)) {
    const profile = requiredProfile(key);
    if (!isRecord(item)) throw invalid("Agent behavior entry is invalid.");
    const dto = validateBehavior({
      profile,
      revision: item.revision,
      subagentMode: item.subagentMode,
      preferredSubagent: item.preferredSubagent,
      preferredCandidateIds: item.preferredCandidateIds,
      updatedAt: item.updatedAt,
    }, sharedCandidates);
    profiles[profile] = {
      revision: dto.revision,
      subagentMode: dto.subagentMode,
      preferredSubagent: dto.preferredSubagent,
      preferredCandidateIds: dto.preferredCandidateIds,
      updatedAt: dto.updatedAt,
    };
  }
  return { sharedCandidates, profiles };
}

function validateBehavior(
  value: {
    profile: string;
    revision: unknown;
    subagentMode: unknown;
    preferredSubagent: unknown;
    preferredCandidateIds?: unknown;
    updatedAt: unknown;
  },
  sharedCandidates: readonly SharedSubagentCandidate[],
): ProfileAgentBehaviorDto {
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) {
    throw invalid("Agent behavior revision is invalid.");
  }
  if (value.subagentMode !== "auto" && value.subagentMode !== "manual") {
    throw invalid("Agent behavior subagentMode is invalid.");
  }
  if (typeof value.preferredSubagent !== "string") throw invalid("Agent behavior preferredSubagent is invalid.");
  if (typeof value.updatedAt !== "string" || value.updatedAt.trim() === "") {
    throw invalid("Agent behavior updatedAt is invalid.");
  }
  const preferredCandidateIds = value.preferredCandidateIds === undefined
    ? []
    : validatePreferredCandidateIds(value.preferredCandidateIds, sharedCandidates);
  return {
    profile: requiredProfile(value.profile),
    revision: value.revision,
    subagentMode: value.subagentMode,
    preferredSubagent: validatePreferredSubagent(value.preferredSubagent),
    preferredCandidateIds,
    updatedAt: value.updatedAt,
  };
}

function validateSharedCandidates(value: unknown): SharedSubagentCandidate[] {
  if (!Array.isArray(value) || value.length > 32) throw invalid("Shared subagent candidates are invalid.");
  const seen = new Set<string>();
  const candidates: SharedSubagentCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item)) throw invalid("Shared subagent candidate is invalid.");
    const id = requiredCandidateId(item.id);
    if (seen.has(id)) throw invalid("Shared subagent candidate ids must be unique.");
    seen.add(id);
    candidates.push({
      id,
      label: validatePreferredSubagent(String(item.label ?? "")),
      provider: validateModelToken(String(item.provider ?? ""), "provider"),
      model: validateModelToken(String(item.model ?? ""), "model"),
      reasoningEffort: validateReasoningEffort(String(item.reasoningEffort ?? "")),
      enabled: item.enabled !== false,
    });
  }
  return candidates;
}

function validatePreferredCandidateIds(
  value: unknown,
  sharedCandidates: readonly SharedSubagentCandidate[],
): string[] {
  if (!Array.isArray(value) || value.length > 3) throw invalid("Preferred candidate list is invalid.");
  const known = new Set(sharedCandidates.map((item) => item.id));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw invalid("Preferred candidate id is invalid.");
    const id = requiredCandidateId(item);
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function sanitizePreferredCandidateIds(
  value: readonly string[],
  sharedCandidates: readonly SharedSubagentCandidate[],
): string[] {
  return validatePreferredCandidateIds(value, sharedCandidates);
}

function derivePreferredSubagentLabel(
  preferredCandidateIds: readonly string[],
  sharedCandidates: readonly SharedSubagentCandidate[],
  fallback: string,
): string {
  const first = resolvePreferredCandidates(preferredCandidateIds, sharedCandidates)[0];
  if (first) return first.label || [first.provider, first.model].filter(Boolean).join("/") || fallback;
  return validatePreferredSubagent(fallback);
}

function validatePreferredSubagent(value: string): string {
  const trimmed = value.trim();
  // Reject control chars and line breaks so the session seed stays a single line.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw invalid("Preferred subagent name is invalid.");
  }
  if (Buffer.byteLength(trimmed) > PREFERRED_SUBAGENT_MAX_BYTES) {
    throw invalid("Preferred subagent name is too long.");
  }
  return trimmed;
}

function validateModelToken(value: string, field: "provider" | "model"): string {
  const trimmed = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw invalid(`Subagent ${field} is invalid.`);
  if (Buffer.byteLength(trimmed) > 128) throw invalid(`Subagent ${field} is too long.`);
  return trimmed;
}

function validateReasoningEffort(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return "";
  if (!/^[a-z0-9_-]{1,32}$/.test(trimmed)) throw invalid("Subagent reasoning effort is invalid.");
  return trimmed;
}

function requiredCandidateId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw invalid("Shared subagent candidate id is invalid.");
  }
  return value;
}

function requiredProfile(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) throw invalid("Profile name is invalid.");
  return value;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): HermesSettingsError {
  return new HermesSettingsError("invalid_request", message);
}
