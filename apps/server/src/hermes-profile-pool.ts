import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { HermesProfileBackendAccess } from "./hermes-settings.js";
import { createHermesChildEnvironment } from "./hermes-child-environment.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export interface HermesProfileBackendPoolOptions {
  executable: string;
  startTimeoutMs?: number;
  maxBackends?: number;
  cwd?: string;
}

interface PoolEntry extends HermesProfileBackendAccess {
  child: ManagedChild;
  lastUsed: number;
}

/** Small LRU pool for Hermes APIs whose scope is the process HERMES_HOME. */
export class HermesProfileBackendPool {
  readonly #options: Required<HermesProfileBackendPoolOptions>;
  readonly #entries = new Map<string, PoolEntry>();
  readonly #starts = new Map<string, Promise<PoolEntry>>();
  #closed = false;

  constructor(options: HermesProfileBackendPoolOptions) {
    if (options.executable.trim() === "" || options.executable.includes("\0")) throw new Error("Hermes executable is invalid.");
    this.#options = {
      executable: options.executable,
      startTimeoutMs: bounded(options.startTimeoutMs, 20_000, 1_000, 60_000),
      maxBackends: bounded(options.maxBackends, 4, 1, 16),
      cwd: options.cwd ?? process.cwd(),
    };
  }

  async resolve(profile: string): Promise<HermesProfileBackendAccess> {
    if (this.#closed) throw new Error("Hermes profile backend pool is closed.");
    if (!PROFILE_PATTERN.test(profile)) throw new Error("Hermes profile name is invalid.");
    const existing = this.#entries.get(profile);
    if (existing !== undefined && existing.child.exitCode === null) {
      existing.lastUsed = Date.now();
      return publicAccess(existing);
    }
    if (existing !== undefined) this.#entries.delete(profile);
    const starting = this.#starts.get(profile);
    if (starting !== undefined) return publicAccess(await starting);

    const promise = this.#start(profile);
    this.#starts.set(profile, promise);
    try { return publicAccess(await promise); }
    finally { this.#starts.delete(profile); }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#starts.values()]);
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(async (entry) => await stopChild(entry.child)));
  }

  async #start(profile: string): Promise<PoolEntry> {
    if (this.#entries.size >= this.#options.maxBackends) await this.#evictOldest();
    const sessionToken = randomBytes(32).toString("base64url");
    const child = spawn(
      this.#options.executable,
      ["--profile", profile, "serve", "--host", "127.0.0.1", "--port", "0"],
      {
        cwd: this.#options.cwd,
        env: createHermesChildEnvironment({ sessionToken, cwd: this.#options.cwd }),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const port = await waitForReadyPort(child, this.#options.startTimeoutMs).catch(async (error: unknown) => {
      await stopChild(child);
      throw error;
    });
    if (this.#closed) { await stopChild(child); throw new Error("Hermes profile backend pool is closed."); }
    const entry: PoolEntry = { child, baseUrl: `http://127.0.0.1:${port}`, sessionToken, lastUsed: Date.now() };
    this.#entries.set(profile, entry);
    child.once("exit", () => { if (this.#entries.get(profile)?.child === child) this.#entries.delete(profile); });
    return entry;
  }

  async #evictOldest(): Promise<void> {
    let oldest: [string, PoolEntry] | undefined;
    for (const item of this.#entries) if (oldest === undefined || item[1].lastUsed < oldest[1].lastUsed) oldest = item;
    if (oldest === undefined) return;
    this.#entries.delete(oldest[0]);
    await stopChild(oldest[1].child);
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
      child.stdout.removeListener("data", inspect);
      child.stderr.removeListener("data", inspect);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error !== undefined) reject(error); else resolve(port!);
    };
    const inspect = (chunk: Buffer): void => {
      if (output.length < 32 * 1024) output += chunk.toString("utf8", 0, 32 * 1024 - output.length);
      const match = /HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d{1,5})/.exec(output);
      const port = match === null ? 0 : Number(match[1]);
      if (port >= 1 && port <= 65_535) finish(undefined, port);
      else if (output.length >= 32 * 1024) finish(new Error("Hermes profile startup output exceeded its limit."));
    };
    const onError = (): void => finish(new Error("Hermes profile process failed to start."));
    const onExit = (): void => finish(new Error("Hermes profile process exited before readiness."));
    const timer = setTimeout(() => finish(new Error("Hermes profile process startup timed out.")), timeoutMs);
    timer.unref();
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChild(child: ManagedChild): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); resolve(); }, 3_000);
    timer.unref();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function publicAccess(entry: PoolEntry): HermesProfileBackendAccess { return { baseUrl: entry.baseUrl, sessionToken: entry.sessionToken }; }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))); }
