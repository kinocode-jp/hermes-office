import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type {
  AgentActivity,
  ChatSessionSummary,
  KanbanBoardSummary,
  OfficeSnapshot,
  ProfileSummary,
  RuntimeStatus,
} from "@hermes-office/protocol";
import { OFFICE_PROTOCOL_VERSION } from "./demo-state.js";
import { createHermesChatTransport, type HermesChatTransport } from "./hermes-chat.js";
import { createHermesKanbanHttpRequester, HermesKanbanAdapter } from "./hermes-kanban.js";
import { GlobalInheritanceCoordinator } from "./global-inheritance.js";
import { HermesProfileBackendPool } from "./hermes-profile-pool.js";
import {
  createHermesSettingsAdapter,
  OfficeGlobalSettingsStore,
  type HermesSettingsAdapter,
} from "./hermes-settings.js";

const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_START_OUTPUT = 32 * 1024;

export interface HermesBackendOptions {
  executable?: string;
  baseUrl?: string;
  sessionToken?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  globalSettingsPath?: string;
  maxProfileBackends?: number;
}

export interface HermesRuntimeSource {
  status(): RuntimeStatus;
  snapshot(): Promise<OfficeSnapshot>;
  close(): Promise<void>;
  chat(): HermesChatTransport;
  kanban(): HermesKanbanAdapter;
  settings?(): HermesSettingsAdapter;
  globalSettings?(): OfficeGlobalSettingsStore;
  globalInheritance?(): GlobalInheritanceCoordinator;
}

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export class HermesBackend implements HermesRuntimeSource {
  readonly #options: HermesBackendOptions;
  #child: ManagedChild | undefined;
  #baseUrl?: URL;
  #token?: string;
  #state: RuntimeStatus;
  #sequence = 0;
  readonly #profilePool: HermesProfileBackendPool;
  readonly #globalSettings: OfficeGlobalSettingsStore;
  #globalInheritance?: GlobalInheritanceCoordinator;

  constructor(options: HermesBackendOptions = {}) {
    this.#options = options;
    this.#profilePool = new HermesProfileBackendPool({
      executable: options.executable?.trim() || "hermes",
      ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
      ...(options.maxProfileBackends === undefined ? {} : { maxBackends: options.maxProfileBackends }),
    });
    this.#globalSettings = new OfficeGlobalSettingsStore(
      options.globalSettingsPath ?? join(homedir(), ".hermes-office", "global-settings.json"),
    );
    this.#state = {
      mode: options.baseUrl === undefined ? "managed-sidecar" : "existing-local",
      state: "unconfigured",
      adapterVersion: "0.2.0",
    };
  }

  status(): RuntimeStatus {
    return { ...this.#state };
  }

  chat(): HermesChatTransport {
    const { baseUrl, token } = this.#connectionConfig();
    return createHermesChatTransport({ baseUrl, sessionToken: token });
  }

  kanban(): HermesKanbanAdapter {
    const { baseUrl, token } = this.#connectionConfig();
    return new HermesKanbanAdapter({
      request: createHermesKanbanHttpRequester({ baseUrl: baseUrl.origin, sessionToken: token }),
      listAllowedProfiles: async () => recordArray(await this.#requestJson("/api/profiles"), "profiles")
        .flatMap((profile) => typeof profile.name === "string" ? [profile.name] : []),
    });
  }

  settings(): HermesSettingsAdapter {
    return createHermesSettingsAdapter({
      resolveProfileBackend: async (profile) => {
        if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
        return await this.#profilePool.resolve(profile);
      },
      ...(this.#options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.#options.requestTimeoutMs }),
    });
  }

  globalSettings(): OfficeGlobalSettingsStore {
    return this.#globalSettings;
  }

  globalInheritance(): GlobalInheritanceCoordinator {
    this.#globalInheritance ??= new GlobalInheritanceCoordinator({
      store: this.#globalSettings,
      settings: this.settings(),
      listProfiles: async () => recordArray(await this.#requestJson("/api/profiles"), "profiles")
        .flatMap((profile) => typeof profile.name === "string" ? [profile.name] : []),
    });
    return this.#globalInheritance;
  }

  async start(): Promise<RuntimeStatus> {
    if (this.#state.state === "starting" || this.#state.state === "ready") return this.status();
    this.#state = { ...this.#state, state: "starting", compatibilityMessage: "Hermes backendを確認しています。" };

    const attempts = this.#options.baseUrl === undefined ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (this.#options.baseUrl !== undefined) {
          this.#baseUrl = safeLoopbackOrigin(this.#options.baseUrl);
          this.#token = requiredToken(this.#options.sessionToken);
        } else {
          await this.#spawnManaged();
        }
        const raw = await this.#requestJson("/api/status", false);
        const version = readString(raw, "version");
        if (version === undefined) throw new IncompatibleHermesError("Hermes status contract is unavailable.");
        this.#state = {
          ...this.#state,
          state: "ready",
          hermesVersion: version,
          compatibilityMessage: "Hermes runtimeに接続済み",
        };
        return this.status();
      } catch (error) {
        lastError = error;
        await this.#stopChild();
        if (error instanceof IncompatibleHermesError) break;
      }
    }
    this.#state = {
      ...this.#state,
      state: lastError instanceof IncompatibleHermesError ? "incompatible" : "unreachable",
      compatibilityMessage: lastError instanceof IncompatibleHermesError
        ? "HermesのAPI契約を確認してください。"
        : "Hermes runtimeを起動できませんでした。",
    };
    return this.status();
  }

  async snapshot(): Promise<OfficeSnapshot> {
    if (this.#state.state !== "ready") return emptySnapshot(this.status(), ++this.#sequence);

    try {
      const [profileWire, sessionWire, boardWire] = await Promise.all([
        this.#requestJson("/api/profiles"),
        this.#requestJson("/api/profiles/sessions?limit=100&offset=0"),
        this.#requestJson("/api/plugins/kanban/board"),
      ]);
      const profiles = mapProfiles(profileWire, sessionWire);
      const sessions = mapSessions(sessionWire);
      const boards = mapBoards(boardWire);
      this.#state = { ...this.#state, state: "ready", compatibilityMessage: "Hermes runtimeに接続済み" };
      return makeSnapshot(this.status(), ++this.#sequence, profiles, sessions, boards);
    } catch {
      // A transient snapshot failure must not disable chat/settings for the
      // rest of the process lifetime. Keep the established transport usable;
      // the next snapshot refresh can recover the visible state.
      const degraded = { ...this.#state, compatibilityMessage: "Hermesの状態を再取得しています。" };
      return emptySnapshot(degraded, ++this.#sequence);
    }
  }

  async close(): Promise<void> {
    this.#state = { ...this.#state, state: "stopping" };
    await Promise.all([this.#stopChild(), this.#profilePool.close()]);
    this.#state = { ...this.#state, state: "stopped" };
  }

  async #spawnManaged(): Promise<void> {
    const executable = this.#options.executable?.trim() || "hermes";
    if (executable.includes("\0")) throw new Error("Invalid Hermes executable.");
    const token = randomBytes(32).toString("base64url");
    const child = spawn(executable, ["serve", "--host", "127.0.0.1", "--port", "0"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERMES_DASHBOARD_SESSION_TOKEN: token,
        HERMES_DESKTOP: "1",
        TERMINAL_CWD: process.cwd(),
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#token = token;
    const port = await waitForReadyPort(child, bounded(this.#options.startTimeoutMs, START_TIMEOUT_MS, 1_000, 60_000));
    this.#baseUrl = new URL(`http://127.0.0.1:${port}`);
  }

  #connectionConfig(): { baseUrl: URL; token: string } {
    if (this.#state.state !== "ready" || this.#baseUrl === undefined || this.#token === undefined) {
      throw new Error("Hermes backend is not ready.");
    }
    return { baseUrl: new URL(this.#baseUrl), token: this.#token };
  }

  async #requestJson(path: string, authenticated = true): Promise<unknown> {
    const baseUrl = this.#baseUrl;
    if (baseUrl === undefined) throw new Error("Hermes backend is not configured.");
    const target = new URL(path, baseUrl);
    if (target.origin !== baseUrl.origin || !target.pathname.startsWith("/api/")) {
      throw new Error("Refusing Hermes request outside the configured API origin.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), bounded(this.#options.requestTimeoutMs, REQUEST_TIMEOUT_MS, 250, 15_000));
    timeout.unref();
    try {
      const response = await fetch(target, {
        headers: {
          Accept: "application/json",
          ...(authenticated && this.#token !== undefined ? { "X-Hermes-Session-Token": this.#token } : {}),
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new IncompatibleHermesError(`Hermes returned ${response.status}.`);
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3_000);
      timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function waitForReadyPort(child: ManagedChild, timeoutMs: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error, port?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error !== undefined) reject(error);
      else resolve(port!);
    };
    const inspect = (chunk: Buffer): void => {
      if (output.length < MAX_START_OUTPUT) output += chunk.toString("utf8", 0, MAX_START_OUTPUT - output.length);
      const match = /HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d{1,5})/.exec(output);
      const port = match === null ? 0 : Number(match[1]);
      if (port >= 1 && port <= 65_535) finish(undefined, port);
      else if (output.length >= MAX_START_OUTPUT) finish(new Error("Hermes startup output exceeded its limit."));
    };
    const onError = (): void => finish(new Error("Hermes process failed to start."));
    const onExit = (): void => finish(new Error("Hermes process exited before readiness."));
    const timer = setTimeout(() => finish(new Error("Hermes startup timed out.")), timeoutMs);
    timer.unref();
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return result + decoder.decode();
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error("Hermes response exceeded its limit."); }
    result += decoder.decode(value, { stream: true });
  }
}

function safeLoopbackOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Existing Hermes URL must be a credential-free HTTP origin.");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1" && url.hostname !== "[::1]") {
    throw new Error("Existing Hermes backend must be loopback-only.");
  }
  return url;
}

function requiredToken(value: string | undefined): string {
  if (value === undefined || value.length < 16 || value.length > 512) throw new Error("Existing Hermes token is missing or invalid.");
  return value;
}

function mapProfiles(value: unknown, sessionsValue: unknown): ProfileSummary[] {
  const rows = recordArray(value, "profiles").slice(0, 100);
  const sessions = recordArray(sessionsValue, "sessions");
  return rows.flatMap((row): ProfileSummary[] => {
    const name = readString(row, "name");
    if (name === undefined) return [];
    const active = sessions.filter((item) => item.profile === name && item.is_active === true).length;
    return [{
      id: name,
      name,
      avatarKey: name,
      activity: activity(row.gateway_running === true, active),
      activeSessionCount: active,
      inheritedSkillCount: 0,
      ownSkillCount: readNumber(row, "skill_count") ?? 0,
      revision: 1,
    }];
  });
}

function mapSessions(value: unknown): ChatSessionSummary[] {
  return recordArray(value, "sessions").slice(0, 100).flatMap((row): ChatSessionSummary[] => {
    const id = readString(row, "id");
    const profile = readString(row, "profile");
    if (id === undefined || profile === undefined) return [];
    return [{
      id,
      profileId: profile,
      title: readString(row, "title") || "Untitled session",
      activity: row.is_active === true ? "thinking" : "idle",
      createdAt: epochToIso(readNumber(row, "started_at")),
      updatedAt: epochToIso(readNumber(row, "last_active") ?? readNumber(row, "ended_at")),
      ...(readString(row, "preview") === undefined ? {} : { lastMessagePreview: readString(row, "preview")!.slice(0, 240) }),
    }];
  });
}

function mapBoards(value: unknown): KanbanBoardSummary[] {
  const columns = recordArray(value, "columns");
  const count = columns.reduce((sum, column) => sum + (Array.isArray(column.tasks) ? column.tasks.length : 0), 0);
  return [{ id: "hermes-kanban", name: "Hermes Kanban", cardCount: count, revision: readNumber(value, "latest_event_id") ?? 0 }];
}

function makeSnapshot(runtime: RuntimeStatus, sequence: number, profiles: ProfileSummary[], sessions: ChatSessionSummary[], boards: KanbanBoardSummary[]): OfficeSnapshot {
  return {
    generatedAt: new Date().toISOString(), sequence,
    capabilities: {
      protocolVersion: OFFICE_PROTOCOL_VERSION, serverVersion: "0.2.0", runtime,
      access: { deviceId: "local-desktop", tier: "owner", exposure: "loopback", authentication: "desktop-capability", allowedOperations: ["state.read"] },
      features: ["chat", "profiles", "skills", "memory", "kanban", "global-inheritance"],
    },
    globalSettings: { sharedContextEnabled: true, sharedSkillsEnabled: true, revision: 1 },
    profiles, sessions, boards,
  };
}

function emptySnapshot(runtime: RuntimeStatus, sequence: number): OfficeSnapshot {
  return makeSnapshot(runtime, sequence, [], [], [{ id: "hermes-kanban", name: "Hermes Kanban", cardCount: 0, revision: 0 }]);
}

function activity(gateway: boolean, active: number): AgentActivity { return active > 0 ? "thinking" : gateway ? "idle" : "offline"; }
function epochToIso(value: number | undefined): string { return new Date((value ?? Date.now() / 1_000) * 1_000).toISOString(); }
function recordArray(value: unknown, key: string): Record<string, unknown>[] { const rows = isRecord(value) ? value[key] : undefined; return Array.isArray(rows) ? rows.filter(isRecord) : []; }
function readString(value: unknown, key: string): string | undefined { const item = isRecord(value) ? value[key] : undefined; return typeof item === "string" ? item : undefined; }
function readNumber(value: unknown, key: string): number | undefined { const item = isRecord(value) ? value[key] : undefined; return typeof item === "number" && Number.isFinite(item) ? item : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))); }

class IncompatibleHermesError extends Error {}
