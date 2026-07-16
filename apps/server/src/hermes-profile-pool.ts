import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { HermesSettingsError, type HermesProfileBackendAccess } from "./hermes-settings.js";
import { createHermesChildEnvironment, discardHermesChildOutput } from "./hermes-child-environment.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export interface HermesProfileBackendPoolOptions {
  executable: string;
  startTimeoutMs?: number;
  maxBackends?: number;
  cwd?: string;
  isKnownProfile?: (profile: string) => Promise<boolean>;
}

interface PoolEntry {
  baseUrl: string;
  sessionToken: string;
  child: ManagedChild;
  lastUsed: number;
  leases: number;
}

interface StartSlot { promise: Promise<PoolEntry>; leases: number }

/** Lease-aware LRU pool for Hermes APIs whose scope is the process HERMES_HOME. */
export class HermesProfileBackendPool {
  readonly #options: Required<Omit<HermesProfileBackendPoolOptions, "isKnownProfile">>
    & Pick<HermesProfileBackendPoolOptions, "isKnownProfile">;
  readonly #entries = new Map<string, PoolEntry>();
  readonly #starts = new Map<string, StartSlot>();
  readonly #capacityWaiters = new Set<() => void>();
  #allocationTail = Promise.resolve();
  #closed = false;

  constructor(options: HermesProfileBackendPoolOptions) {
    if (options.executable.trim() === "" || options.executable.includes("\0")) throw new Error("Hermes executable is invalid.");
    this.#options = {
      executable: options.executable,
      startTimeoutMs: bounded(options.startTimeoutMs, 20_000, 1_000, 60_000),
      maxBackends: bounded(options.maxBackends, 4, 1, 16),
      cwd: options.cwd ?? process.cwd(),
      ...(options.isKnownProfile === undefined ? {} : { isKnownProfile: options.isKnownProfile }),
    };
  }

  async resolve(profile: string): Promise<HermesProfileBackendAccess> {
    if (this.#closed) throw new Error("Hermes profile backend pool is closed.");
    if (!PROFILE_PATTERN.test(profile)) throw new Error("Hermes profile name is invalid.");
    if (this.#options.isKnownProfile !== undefined && !await this.#options.isKnownProfile(profile)) {
      throw new HermesSettingsError("not_found", "Hermes profile does not exist.");
    }
    const existing = this.#entries.get(profile);
    if (existing !== undefined && existing.child.exitCode === null) {
      existing.leases += 1;
      return this.#publicLease(existing);
    }
    if (existing !== undefined) this.#entries.delete(profile);
    const starting = this.#starts.get(profile);
    if (starting !== undefined) {
      starting.leases += 1;
      return this.#publicLease(await starting.promise);
    }

    const allocation = await this.#allocate(profile);
    return this.#publicLease(await allocation.promise);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#notifyCapacity();
    await this.#allocationTail;
    await Promise.allSettled([...this.#starts.values()].map((slot) => slot.promise));
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(async (entry) => await stopChild(entry.child)));
  }

  async #start(profile: string): Promise<PoolEntry> {
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
    const entry: PoolEntry = { child, baseUrl: `http://127.0.0.1:${port}`, sessionToken, lastUsed: Date.now(), leases: 0 };
    child.once("exit", () => {
      if (this.#entries.get(profile)?.child === child) this.#entries.delete(profile);
      this.#notifyCapacity();
    });
    return entry;
  }

  async #allocate(profile: string): Promise<{ promise: Promise<PoolEntry> }> {
    const previous = this.#allocationTail;
    let release!: () => void;
    this.#allocationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.#closed) throw new Error("Hermes profile backend pool is closed.");
      const existing = this.#entries.get(profile);
      if (existing !== undefined && existing.child.exitCode === null) {
        existing.leases += 1;
        return { promise: Promise.resolve(existing) };
      }
      if (existing !== undefined) this.#entries.delete(profile);
      const starting = this.#starts.get(profile);
      if (starting !== undefined) {
        starting.leases += 1;
        return { promise: starting.promise };
      }

      while (this.#entries.size + this.#starts.size >= this.#options.maxBackends) {
        if (this.#oldestIdle() !== undefined) {
          await this.#evictOldestIdle();
        } else {
          await this.#waitForCapacity();
        }
        if (this.#closed) throw new Error("Hermes profile backend pool is closed.");
      }

      const started = this.#start(profile);
      const slot = { promise: started, leases: 1 } satisfies StartSlot;
      let tracked!: Promise<PoolEntry>;
      tracked = started.then(
        (entry) => {
          if (this.#starts.get(profile) === slot) this.#starts.delete(profile);
          if (entry.child.exitCode !== null) {
            this.#notifyCapacity();
            throw new Error("Hermes profile process exited during startup.");
          }
          entry.leases = slot.leases;
          this.#entries.set(profile, entry);
          return entry;
        },
        (error: unknown) => {
          if (this.#starts.get(profile) === slot) this.#starts.delete(profile);
          this.#notifyCapacity();
          throw error;
        },
      );
      slot.promise = tracked;
      this.#starts.set(profile, slot);
      return { promise: tracked };
    } finally {
      release();
    }
  }

  #oldestIdle(): [string, PoolEntry] | undefined {
    let oldest: [string, PoolEntry] | undefined;
    for (const item of this.#entries) {
      if (item[1].leases === 0 && (oldest === undefined || item[1].lastUsed < oldest[1].lastUsed)) oldest = item;
    }
    return oldest;
  }

  async #evictOldestIdle(): Promise<void> {
    const oldest = this.#oldestIdle();
    if (oldest === undefined) return;
    this.#entries.delete(oldest[0]);
    await stopChild(oldest[1].child);
    this.#notifyCapacity();
  }

  async #waitForCapacity(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: HermesSettingsError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#capacityWaiters.delete(ready);
        if (error === undefined) resolve(); else reject(error);
      };
      const ready = (): void => finish();
      const timer = setTimeout(() => finish(new HermesSettingsError("timed_out", "Hermes profile capacity is busy.")), this.#options.startTimeoutMs);
      timer.unref();
      this.#capacityWaiters.add(ready);
    });
  }

  #notifyCapacity(): void {
    const waiters = [...this.#capacityWaiters];
    this.#capacityWaiters.clear();
    for (const ready of waiters) ready();
  }

  #publicLease(entry: PoolEntry): HermesProfileBackendAccess {
    let released = false;
    return {
      baseUrl: entry.baseUrl,
      sessionToken: entry.sessionToken,
      release: () => {
        if (released) return;
        released = true;
        entry.leases = Math.max(0, entry.leases - 1);
        entry.lastUsed = Date.now();
        this.#notifyCapacity();
      },
    };
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
      discardHermesChildOutput(child);
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

function bounded(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))); }
