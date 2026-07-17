import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type {
  KanbanBoardSummary,
  OfficeInventoryKind,
  OfficeInventoryPage,
  OfficeInventoryMetadata,
  OfficeSnapshot,
  RuntimeStatus,
} from "@hermes-office/protocol";
import { OFFICE_PROTOCOL_VERSION } from "./demo-state.js";
import { createHermesChatTransport, type HermesChatTransport } from "./hermes-chat.js";
import { createHermesChildEnvironment, discardHermesChildOutput } from "./hermes-child-environment.js";
import { collectHermesInventory, HermesInventoryCache, type CollectedHermesInventory, type HermesJsonResult } from "./hermes-inventory.js";
import { createHermesKanbanHttpRequester, HermesKanbanAdapter } from "./hermes-kanban.js";
import { GlobalInheritanceCoordinator } from "./global-inheritance.js";
import { HermesProfileBackendPool } from "./hermes-profile-pool.js";
import { isSupportedHermesVersion, probeHermesCli } from "./hermes-runtime.js";
import {
  createHermesSettingsAdapter,
  OfficeGlobalSettingsStore,
  type HermesSettingsAdapter,
} from "./hermes-settings.js";

const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_START_OUTPUT = 32 * 1024;
const MANAGED_RESTART_ATTEMPTS = 3;
const MANAGED_RESTART_BACKOFF_MS = 250;

export interface HermesBackendOptions {
  executable?: string;
  baseUrl?: string;
  sessionToken?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  globalSettingsPath?: string;
  maxProfileBackends?: number;
  managedRestartAttempts?: number;
  managedRestartBackoffMs?: number;
}

export interface HermesRuntimeSource {
  status(): RuntimeStatus;
  snapshot(): Promise<OfficeSnapshot>;
  inventoryPage?(kind: OfficeInventoryKind, cursor: string, limit: number): Promise<OfficeInventoryPage>;
  close(): Promise<void>;
  chat(options?: { maxEventBytes?: number }): HermesChatTransport;
  kanban(): HermesKanbanAdapter;
  settings?(): HermesSettingsAdapter;
  globalSettings?(): OfficeGlobalSettingsStore;
  globalInheritance?(): GlobalInheritanceCoordinator;
  onStatusChange?(listener: (status: RuntimeStatus) => void): () => void;
}

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export class HermesBackend implements HermesRuntimeSource {
  readonly #options: HermesBackendOptions;
  #child: ManagedChild | undefined;
  #baseUrl: URL | undefined;
  #token: string | undefined;
  #state: RuntimeStatus;
  #sequence = 0;
  readonly #profilePool: HermesProfileBackendPool;
  readonly #globalSettings: OfficeGlobalSettingsStore;
  readonly #inventory = new HermesInventoryCache();
  #snapshotRefresh: Promise<{ inventory: CollectedHermesInventory; boards: KanbanBoardSummary[] }> | undefined;
  #globalInheritance?: GlobalInheritanceCoordinator;
  #settingsAdapter?: HermesSettingsAdapter;
  #childGeneration = 0;
  #recoveryFlight: Promise<void> | undefined;
  #shutdownRequested = false;
  readonly #statusListeners = new Set<(status: RuntimeStatus) => void>();

  constructor(options: HermesBackendOptions = {}) {
    this.#options = options;
    this.#profilePool = new HermesProfileBackendPool({
      executable: options.executable?.trim() || "hermes",
      ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
      ...(options.maxProfileBackends === undefined ? {} : { maxBackends: options.maxProfileBackends }),
      isKnownProfile: async (profile) => recordArray(await this.#requestJson("/api/profiles"), "profiles")
        .some((item) => item.name === profile),
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

  onStatusChange(listener: (status: RuntimeStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  chat(options: { maxEventBytes?: number } = {}): HermesChatTransport {
    const { baseUrl, token } = this.#connectionConfig();
    const maxEventBytes = options.maxEventBytes;
    return createHermesChatTransport({
      baseUrl,
      sessionToken: token,
      ...(maxEventBytes === undefined ? {} : {
        maxFrameBytes: Math.max(4_096, maxEventBytes),
        maxTextBytes: Math.max(1_024, maxEventBytes - 2_048),
      }),
    });
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
    this.#settingsAdapter ??= createHermesSettingsAdapter({
      resolveProfileBackend: async (profile) => {
        if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
        return await this.#profilePool.resolve(profile);
      },
      ...(this.#options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.#options.requestTimeoutMs }),
    });
    return this.#settingsAdapter;
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
    if (this.#shutdownRequested) return this.status();
    if (this.#recoveryFlight !== undefined) {
      await this.#recoveryFlight;
      return this.status();
    }
    this.#setState({ ...this.#state, state: "starting", compatibilityMessage: "Hermes backendを確認しています。" });

    const attempts = this.#options.baseUrl === undefined ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (this.#options.baseUrl !== undefined) {
          this.#baseUrl = safeLoopbackOrigin(this.#options.baseUrl);
          this.#token = requiredToken(this.#options.sessionToken);
        } else {
          const executable = this.#options.executable?.trim() || "hermes";
          const cli = await probeHermesCli(executable, 5_000);
          if (cli.state !== "available" || cli.version === undefined) {
            throw new IncompatibleHermesError("Hermes CLI is unavailable or unsupported.");
          }
          await this.#spawnManaged();
        }
        const version = await this.#compatibleVersion();
        this.#observeManagedChild();
        this.#setState({
          ...this.#state,
          state: "ready",
          hermesVersion: version,
          compatibilityMessage: "Hermes runtimeに接続済み",
        });
        return this.status();
      } catch (error) {
        lastError = error;
        await this.#stopChild();
        if (error instanceof IncompatibleHermesError) break;
      }
    }
    this.#setState({
      ...this.#state,
      state: lastError instanceof IncompatibleHermesError ? "incompatible" : "unreachable",
      compatibilityMessage: lastError instanceof IncompatibleHermesError
        ? "HermesのAPI契約を確認してください。"
        : "Hermes runtimeを起動できませんでした。",
    });
    return this.status();
  }

  async snapshot(): Promise<OfficeSnapshot> {
    if (this.#state.state !== "ready") return emptySnapshot(this.status(), ++this.#sequence);

    try {
      const { inventory, boards } = await this.#collectSnapshotData();
      const firstPage = this.#inventory.replace(inventory);
      this.#setState({ ...this.#state, state: "ready", compatibilityMessage: "Hermes runtimeに接続済み" });
      return makeSnapshot(this.status(), ++this.#sequence, firstPage.profiles, firstPage.sessions, firstPage.metadata, boards);
    } catch {
      // A transient snapshot failure must not disable chat/settings for the
      // rest of the process lifetime. Keep the established transport usable;
      // the next snapshot refresh can recover the visible state.
      const degraded = { ...this.#state, compatibilityMessage: "Hermesの状態を再取得しています。" };
      return unavailableSnapshot(degraded, ++this.#sequence);
    }
  }

  async inventoryPage(kind: OfficeInventoryKind, cursor: string, limit: number): Promise<OfficeInventoryPage> {
    if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
    return this.#inventory.page(kind, cursor, limit);
  }

  async #collectSnapshotData(): Promise<{ inventory: CollectedHermesInventory; boards: KanbanBoardSummary[] }> {
    const current = this.#snapshotRefresh;
    if (current !== undefined) return await current;
    const refresh = Promise.all([
      collectHermesInventory(async (path, timeoutMs) => await this.#requestJsonResult(path, true, timeoutMs)),
      this.#collectBoardSummaries(),
    ]).then(([inventory, boards]) => ({ inventory, boards }));
    this.#snapshotRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.#snapshotRefresh === refresh) this.#snapshotRefresh = undefined;
    }
  }

  async #collectBoardSummaries(): Promise<KanbanBoardSummary[]> {
    try {
      return mapBoards(await this.#requestJson("/api/plugins/kanban/board"));
    } catch {
      // Kanban is an optional, independently-failing feature. An unavailable
      // or incompatible board must not discard otherwise healthy inventory.
      return emptyBoards();
    }
  }

  async close(): Promise<void> {
    if (this.#state.state === "stopped") return;
    this.#shutdownRequested = true;
    this.#setState({ ...this.#state, state: "stopping" });
    await this.#recoveryFlight;
    await Promise.all([this.#stopChild(), this.#profilePool.close()]);
    this.#setState({ ...this.#state, state: "stopped" });
  }

  async #spawnManaged(): Promise<void> {
    const executable = this.#options.executable?.trim() || "hermes";
    if (executable.includes("\0")) throw new Error("Invalid Hermes executable.");
    const token = randomBytes(32).toString("base64url");
    const child = spawn(executable, ["serve", "--host", "127.0.0.1", "--port", "0"], {
      cwd: process.cwd(),
      env: createHermesChildEnvironment({ sessionToken: token, cwd: process.cwd() }),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#childGeneration += 1;
    this.#child = child;
    this.#token = token;
    const port = await waitForReadyPort(child, bounded(this.#options.startTimeoutMs, START_TIMEOUT_MS, 1_000, 60_000));
    this.#baseUrl = new URL(`http://127.0.0.1:${port}`);
  }

  #observeManagedChild(): void {
    if (this.#options.baseUrl !== undefined) return;
    const child = this.#child;
    const generation = this.#childGeneration;
    if (child === undefined) return;
    const onExit = (): void => this.#handleManagedExit(child, generation);
    child.once("exit", onExit);
    if (child.exitCode !== null) queueMicrotask(onExit);
  }

  async #compatibleVersion(): Promise<string> {
    const raw = await this.#requestJson("/api/status", false);
    const version = readString(raw, "version");
    if (version === undefined) throw new IncompatibleHermesError("Hermes status contract is unavailable.");
    if (!isSupportedHermesVersion(version)) throw new IncompatibleHermesError("Hermes API version is unsupported.");
    return version;
  }

  #handleManagedExit(child: ManagedChild, generation: number): void {
    if (this.#shutdownRequested || this.#child !== child || this.#childGeneration !== generation) return;
    this.#child = undefined;
    this.#baseUrl = undefined;
    this.#token = undefined;
    this.#snapshotRefresh = undefined;
    this.#setState({ ...this.#state, state: "unreachable", compatibilityMessage: "Hermes runtimeが終了したため再起動しています。" });
    this.#startRecovery();
  }

  #startRecovery(): void {
    if (this.#shutdownRequested || this.#options.baseUrl !== undefined || this.#recoveryFlight !== undefined) return;
    const recovery = this.#recoverManaged();
    this.#recoveryFlight = recovery;
    void recovery.finally(() => {
      if (this.#recoveryFlight === recovery) this.#recoveryFlight = undefined;
    }).catch(() => undefined);
  }

  async #recoverManaged(): Promise<void> {
    const attempts = bounded(this.#options.managedRestartAttempts, MANAGED_RESTART_ATTEMPTS, 1, 5);
    const backoffMs = bounded(this.#options.managedRestartBackoffMs, MANAGED_RESTART_BACKOFF_MS, 10, 5_000);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await delay(backoffMs * (attempt + 1));
      if (this.#shutdownRequested) return;
      this.#setState({ ...this.#state, state: "starting", compatibilityMessage: `Hermes runtimeを再起動しています (${attempt + 1}/${attempts})。` });
      try {
        await this.#spawnManaged();
        const version = await this.#compatibleVersion();
        if (this.#shutdownRequested) { await this.#stopChild(); return; }
        this.#observeManagedChild();
        this.#setState({ ...this.#state, state: "ready", hermesVersion: version, compatibilityMessage: "Hermes runtimeに再接続しました。" });
        await delay(backoffMs);
        if (this.#shutdownRequested) { await this.#stopChild(); return; }
        if (this.#state.state !== "ready" || this.#child === undefined) {
          lastError = new Error("Recovered Hermes process exited before the stability window.");
          continue;
        }
        return;
      } catch (error) {
        lastError = error;
        await this.#stopChild();
        if (error instanceof IncompatibleHermesError) {
          this.#setState({ ...this.#state, state: "incompatible", compatibilityMessage: "再起動したHermesのAPI契約が互換ではありません。" });
          return;
        }
        if (!this.#shutdownRequested) this.#setState({ ...this.#state, state: "unreachable", compatibilityMessage: "Hermes runtimeの再起動を再試行します。" });
      }
    }
    if (!this.#shutdownRequested) {
      this.#setState({ ...this.#state, state: "error", compatibilityMessage: lastError === undefined
        ? "Hermes runtimeの再起動回数が上限に達しました。"
        : "Hermes runtimeを再起動できませんでした。Officeを再起動してください。" });
    }
  }

  #setState(state: RuntimeStatus): void {
    const changed = JSON.stringify(state) !== JSON.stringify(this.#state);
    this.#state = state;
    if (!changed) return;
    const snapshot = this.status();
    for (const listener of this.#statusListeners) {
      try { listener(snapshot); } catch { /* Runtime supervision must survive observer failures. */ }
    }
  }

  #connectionConfig(): { baseUrl: URL; token: string } {
    if (this.#state.state !== "ready" || this.#baseUrl === undefined || this.#token === undefined) {
      throw new Error("Hermes backend is not ready.");
    }
    return { baseUrl: new URL(this.#baseUrl), token: this.#token };
  }

  async #requestJson(path: string, authenticated = true): Promise<unknown> {
    return (await this.#requestJsonResult(path, authenticated)).value;
  }

  async #requestJsonResult(path: string, authenticated = true, timeoutLimitMs?: number): Promise<HermesJsonResult> {
    const baseUrl = this.#baseUrl;
    if (baseUrl === undefined) throw new Error("Hermes backend is not configured.");
    const target = new URL(path, baseUrl);
    if (target.origin !== baseUrl.origin || !target.pathname.startsWith("/api/")) {
      throw new Error("Refusing Hermes request outside the configured API origin.");
    }
    const controller = new AbortController();
    const configuredTimeout = bounded(this.#options.requestTimeoutMs, REQUEST_TIMEOUT_MS, 250, 15_000);
    const timeoutMs = timeoutLimitMs === undefined ? configuredTimeout : Math.max(1, Math.min(configuredTimeout, Math.trunc(timeoutLimitMs)));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
      return { value: JSON.parse(text) as unknown, bytes: Buffer.byteLength(text) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (this.#options.baseUrl === undefined) {
      this.#baseUrl = undefined;
      this.#token = undefined;
    }
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

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
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
      discardHermesChildOutput(child);
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

function mapBoards(value: unknown): KanbanBoardSummary[] {
  if (!isRecord(value) || !Array.isArray(value.columns)) throw new Error("Hermes Kanban board contract is incompatible.");
  let count = 0;
  for (const column of value.columns) {
    if (!isRecord(column) || (column.tasks !== undefined && !Array.isArray(column.tasks))) {
      throw new Error("Hermes Kanban column contract is incompatible.");
    }
    count += Array.isArray(column.tasks) ? column.tasks.length : 0;
    if (!Number.isSafeInteger(count)) throw new Error("Hermes Kanban card count is invalid.");
  }
  const revision = value.latest_event_id;
  if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) {
    throw new Error("Hermes Kanban revision is invalid.");
  }
  return [{ id: "hermes-kanban", name: "Hermes Kanban", cardCount: count, revision: revision ?? 0 }];
}

function emptyBoards(): KanbanBoardSummary[] {
  return [{ id: "hermes-kanban", name: "Hermes Kanban", cardCount: 0, revision: 0 }];
}

function makeSnapshot(runtime: RuntimeStatus, sequence: number, profiles: OfficeSnapshot["profiles"], sessions: OfficeSnapshot["sessions"], inventory: OfficeInventoryMetadata, boards: KanbanBoardSummary[]): OfficeSnapshot {
  return {
    generatedAt: new Date().toISOString(), sequence,
    capabilities: {
      protocolVersion: OFFICE_PROTOCOL_VERSION, serverVersion: "0.2.0", runtime,
      access: { deviceId: "local-desktop", tier: "owner", exposure: "loopback", authentication: "desktop-capability", allowedOperations: ["state.read"] },
      features: ["chat", "profiles", "skills", "memory", "kanban", "global-inheritance"],
    },
    globalSettings: { sharedContextEnabled: true, sharedSkillsEnabled: true, revision: 1 },
    profiles, sessions, inventory, boards,
  };
}

function emptySnapshot(runtime: RuntimeStatus, sequence: number): OfficeSnapshot {
  const empty = { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0 };
  return makeSnapshot(runtime, sequence, [], [], { profiles: empty, sessions: empty }, emptyBoards());
}

function unavailableSnapshot(runtime: RuntimeStatus, sequence: number): OfficeSnapshot {
  const unavailable = { returned: 0, available: 0, hasMore: false, truncated: true, partialFailures: 1 };
  return makeSnapshot(runtime, sequence, [], [], { profiles: unavailable, sessions: unavailable }, emptyBoards());
}

function recordArray(value: unknown, key: string): Record<string, unknown>[] { const rows = isRecord(value) ? value[key] : undefined; return Array.isArray(rows) ? rows.filter(isRecord) : []; }
function readString(value: unknown, key: string): string | undefined { const item = isRecord(value) ? value[key] : undefined; return typeof item === "string" ? item : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))); }

class IncompatibleHermesError extends Error {}
