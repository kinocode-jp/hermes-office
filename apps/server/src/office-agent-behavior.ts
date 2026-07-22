import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { HermesSettingsError } from "./hermes-settings.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PREFERRED_SUBAGENT_MAX_BYTES = 128;

export type SubagentMode = "auto" | "manual";

export interface ProfileAgentBehaviorDto {
  profile: string;
  revision: number;
  subagentMode: SubagentMode;
  preferredSubagent: string;
  updatedAt: string;
}

export interface OfficeAgentBehaviorUpdate {
  expectedRevision: number;
  subagentMode?: SubagentMode;
  preferredSubagent?: string;
}

export interface OfficeAgentBehaviorStoreOptions {
  /** Testable storage boundary; throwing leaves the previous atomic state intact. */
  beforeWrite?: (state: OfficeAgentBehaviorFileState) => Promise<void> | void;
}

export interface OfficeAgentBehaviorFileState {
  profiles: Record<string, Omit<ProfileAgentBehaviorDto, "profile">>;
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

  async read(profile: string): Promise<ProfileAgentBehaviorDto> {
    await this.#queue;
    const name = requiredProfile(profile);
    const state = await this.#readStateUnsafe();
    return materialize(name, state.profiles[name]);
  }

  async update(profile: string, input: OfficeAgentBehaviorUpdate): Promise<ProfileAgentBehaviorDto> {
    return await this.#mutate(async () => {
      const name = requiredProfile(profile);
      const state = await this.#readStateUnsafe();
      const current = materialize(name, state.profiles[name]);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision) {
        throw new HermesSettingsError("conflict", "Agent behavior changed; refresh before saving.");
      }
      const next: ProfileAgentBehaviorDto = {
        profile: name,
        revision: current.revision + 1,
        subagentMode: input.subagentMode ?? current.subagentMode,
        preferredSubagent: input.preferredSubagent !== undefined
          ? validatePreferredSubagent(input.preferredSubagent)
          : current.preferredSubagent,
        updatedAt: new Date().toISOString(),
      };
      validateBehavior(next);
      const profiles = { ...state.profiles, [name]: {
        revision: next.revision,
        subagentMode: next.subagentMode,
        preferredSubagent: next.preferredSubagent,
        updatedAt: next.updatedAt,
      } };
      await this.#writeState({ profiles });
      return next;
    });
  }

  /**
   * Returns a short system-seed instruction for `session.create` when the
   * profile prefers proactive subagents; otherwise `undefined`.
   */
  async sessionCreateInstruction(profile: string): Promise<string | undefined> {
    const behavior = await this.read(profile);
    return buildSubagentSessionInstruction(behavior);
  }

  async #readStateUnsafe(): Promise<OfficeAgentBehaviorFileState> {
    try {
      const text = await readFile(this.#filePath, "utf8");
      return validateFileState(JSON.parse(text) as unknown);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { profiles: {} };
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
  behavior: Pick<ProfileAgentBehaviorDto, "subagentMode" | "preferredSubagent">,
): string | undefined {
  if (behavior.subagentMode !== "auto") return undefined;
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

function materialize(
  profile: string,
  value: Omit<ProfileAgentBehaviorDto, "profile"> | undefined,
): ProfileAgentBehaviorDto {
  if (value === undefined) return defaultBehavior(profile);
  return validateBehavior({ profile, ...value });
}

function defaultBehavior(profile: string): ProfileAgentBehaviorDto {
  return {
    profile,
    revision: 0,
    subagentMode: "manual",
    preferredSubagent: "",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function validateFileState(value: unknown): OfficeAgentBehaviorFileState {
  if (!isRecord(value) || !isRecord(value.profiles)) throw invalid("Agent behavior store is invalid.");
  const profiles: OfficeAgentBehaviorFileState["profiles"] = {};
  for (const [key, item] of Object.entries(value.profiles)) {
    const profile = requiredProfile(key);
    if (!isRecord(item)) throw invalid("Agent behavior entry is invalid.");
    const dto = validateBehavior({
      profile,
      revision: item.revision,
      subagentMode: item.subagentMode,
      preferredSubagent: item.preferredSubagent,
      updatedAt: item.updatedAt,
    });
    profiles[profile] = {
      revision: dto.revision,
      subagentMode: dto.subagentMode,
      preferredSubagent: dto.preferredSubagent,
      updatedAt: dto.updatedAt,
    };
  }
  return { profiles };
}

function validateBehavior(value: {
  profile: string;
  revision: unknown;
  subagentMode: unknown;
  preferredSubagent: unknown;
  updatedAt: unknown;
}): ProfileAgentBehaviorDto {
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
  return {
    profile: requiredProfile(value.profile),
    revision: value.revision,
    subagentMode: value.subagentMode,
    preferredSubagent: validatePreferredSubagent(value.preferredSubagent),
    updatedAt: value.updatedAt,
  };
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
