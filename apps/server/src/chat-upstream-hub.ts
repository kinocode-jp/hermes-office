import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesChatTransportError } from "./hermes-chat.js";
import type {
  HermesChatConnection,
  HermesChatEvent,
  HermesChatInternalRequestOptions,
  HermesChatRequest,
  HermesChatResult,
} from "./hermes-chat.js";
import {
  ChatSessionCoordinator,
  type ChatSessionLeaseSnapshot,
  type ChatSessionOwner,
} from "./chat-session-coordinator.js";
import {
  estimateTokensFromText,
  type TokenUsageStore,
} from "./usage-stats.js";

const MAX_UNBOUND_SESSIONS = 64;
const MAX_UNBOUND_EVENTS = 128;
const MAX_EVENTS_PER_SESSION = 32;
const MAX_UNBOUND_BYTES = 256 * 1024;
const MAX_PENDING_SESSION_SETTLEMENT_MS = 16_000;
const OWNED_LIVE_METHODS = new Set<HermesChatRequest["method"]>(["prompt.submit", "session.steer", "session.interrupt"]);
const OWNED_SESSION_REQUEST_METHODS = new Set<HermesChatRequest["method"]>([
  ...OWNED_LIVE_METHODS, "approval.respond", "clarify.respond",
]);

export interface ChatHubSubscriber {
  onEvent(event: HermesChatEvent): void;
  onUnavailable(liveSessionIds: readonly string[]): void;
}

export interface ChatSessionStartSettlement {
  settle(): void;
}

type PendingSessionStart = { promise: Promise<void>; settle(): void };

type LeaseCloseOperationResult = {
  completed: boolean;
  results: ReadonlyMap<string, HermesChatResult>;
};

type LeaseCloseResult = LeaseCloseOperationResult & {
  joined: boolean;
  targetResult?: HermesChatResult;
};

type BufferedEvents = {
  events: HermesChatEvent[];
  bytes: number;
  dropped: boolean;
};

/** A prompt may have reached Hermes, but Office could not observe its authoritative result. */
export class ChatCommitUnconfirmedError extends Error {
  constructor() {
    super("Hermes prompt commit could not be confirmed.");
    this.name = "ChatCommitUnconfirmedError";
  }
}

/** One process-wide Hermes transport shared by every downstream Chat socket. */
export class ChatUpstreamHub {
  readonly #runtimeSource: HermesRuntimeSource;
  readonly #coordinator: ChatSessionCoordinator;
  readonly #maxEventBytes: number;
  readonly #pendingSessionSettlementMs: number;
  readonly #usage: TokenUsageStore | undefined;
  readonly #subscribers = new Map<ChatSessionOwner, ChatHubSubscriber>();
  readonly #unbound = new Map<string, BufferedEvents>();
  readonly #droppedUnbound = new Set<string>();
  readonly #ownerCleanup = new Map<ChatSessionOwner, Promise<boolean>>();
  readonly #cleanupOperations = new Set<Promise<boolean>>();
  readonly #pendingSessionStarts = new Map<ChatSessionOwner, Set<PendingSessionStart>>();
  readonly #leaseCloseOperations = new Map<symbol, Promise<LeaseCloseOperationResult>>();
  #unboundEventCount = 0;
  #unboundBytes = 0;
  #connection: HermesChatConnection | undefined;
  #connecting: Promise<HermesChatConnection> | undefined;
  #resetting: Promise<void> | undefined;
  #generation = 0;
  #cleanupEpoch = 0;
  #stopping = false;

  constructor(
    runtimeSource: HermesRuntimeSource,
    coordinator: ChatSessionCoordinator,
    maxEventBytes: number,
    options: { pendingSessionSettlementMs?: number; usage?: TokenUsageStore } = {},
  ) {
    this.#runtimeSource = runtimeSource;
    this.#coordinator = coordinator;
    this.#maxEventBytes = Math.max(4_096, maxEventBytes);
    this.#usage = options.usage;
    const settlementMs = options.pendingSessionSettlementMs ?? MAX_PENDING_SESSION_SETTLEMENT_MS;
    this.#pendingSessionSettlementMs = Number.isFinite(settlementMs)
      ? Math.max(1, Math.min(60_000, Math.trunc(settlementMs)))
      : MAX_PENDING_SESSION_SETTLEMENT_MS;
  }

  async attach(owner: ChatSessionOwner, subscriber: ChatHubSubscriber): Promise<void> {
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    this.#subscribers.set(owner, subscriber);
    try {
      while (true) {
        await this.#waitForCleanup();
        const cleanupEpoch = this.#cleanupEpoch;
        await this.#ensureConnection();
        if (this.#cleanupOperations.size === 0 && cleanupEpoch === this.#cleanupEpoch) break;
      }
    }
    catch (error) {
      if (this.#subscribers.get(owner) === subscriber) this.#subscribers.delete(owner);
      throw error;
    }
  }

  detach(owner: ChatSessionOwner): void {
    this.#subscribers.delete(owner);
  }

  async request(
    owner: ChatSessionOwner,
    request: HermesChatRequest,
    internal?: HermesChatInternalRequestOptions,
    authorize?: () => boolean,
  ): Promise<HermesChatResult> {
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    if (request.method === "session.close") {
      throw new Error("Explicit session close requires Office ownership.");
    }
    if (!this.#subscribers.has(owner)) throw new Error("Chat owner is detached.");
    if (OWNED_LIVE_METHODS.has(request.method)) {
      const sessionId = typeof request.params?.session_id === "string" ? request.params.session_id : undefined;
      const leaseToken = sessionId === undefined ? undefined : this.#coordinator.liveLeaseToken(owner, sessionId);
      if (sessionId === undefined || leaseToken === undefined) {
        throw new Error("Hermes live session is not owned by this Office connection.");
      }
      return await this.#requestUnchecked(
        request, internal,
        () => this.#subscribers.has(owner) && this.#coordinator.ownsLiveLease(owner, sessionId, leaseToken)
          && (authorize?.() ?? true),
      );
    }
    return await this.#requestUnchecked(
      request, internal,
      () => this.#subscribers.has(owner) && (authorize?.() ?? true),
    );
  }

  beginSessionStart(owner: ChatSessionOwner): ChatSessionStartSettlement {
    if (!this.#subscribers.has(owner)) throw new Error("Chat owner is detached.");
    let resolve!: () => void;
    let settled = false;
    const promise = new Promise<void>((done) => { resolve = done; });
    const starts = this.#pendingSessionStarts.get(owner) ?? new Set<PendingSessionStart>();
    const pending: PendingSessionStart = {
      promise,
      settle: () => {
        if (settled) return;
        settled = true;
        starts.delete(pending);
        if (starts.size === 0) this.#pendingSessionStarts.delete(owner);
        resolve();
      },
    };
    starts.add(pending);
    this.#pendingSessionStarts.set(owner, starts);
    return pending;
  }

  async requestOwnedSession(
    owner: ChatSessionOwner,
    liveSessionId: string,
    expectedLeaseToken: symbol,
    request: HermesChatRequest,
    authorize?: () => boolean,
  ): Promise<HermesChatResult> {
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    if (!OWNED_SESSION_REQUEST_METHODS.has(request.method)) {
      throw new Error("Hermes method is not allowed on the owned-session request path.");
    }
    if (request.method !== "clarify.respond" && request.params?.session_id !== liveSessionId) {
      throw new Error("Hermes request target does not match its owned live session.");
    }
    if (!this.#subscribers.has(owner)) throw new Error("Chat owner is detached.");
    if (!this.#coordinator.ownsLiveLease(owner, liveSessionId, expectedLeaseToken)) {
      throw new Error("Hermes live session is not owned by this Office connection.");
    }
    const authorizeCommand = (): boolean => this.#subscribers.has(owner)
      && this.#coordinator.ownsLiveLease(owner, liveSessionId, expectedLeaseToken)
      && (authorize?.() ?? true);
    // Once Hermes has received a mutation, close may fence new commands without
    // changing its route. Accept that authoritative ACK only for the exact
    // routing lease; release, reuse, or ownership transfer still fails closed.
    const authorizeSettlement = (): boolean => this.#coordinator.routingLeaseToken(owner, liveSessionId)
      === expectedLeaseToken;
    return await this.#requestUnchecked(
      request, undefined,
      authorizeCommand,
      authorizeSettlement,
    );
  }

  async #requestUnchecked(
    request: HermesChatRequest,
    internal?: HermesChatInternalRequestOptions,
    authorize?: () => boolean,
    authorizeSettlement: (() => boolean) | undefined = authorize,
  ): Promise<HermesChatResult> {
    const connection = await this.#ensureConnection();
    if (authorize !== undefined && !authorize()) throw new Error("Hermes live session ownership changed.");
    const generation = this.#generation;
    try {
      const result = await connection.request(request, internal);
      if (generation !== this.#generation || connection !== this.#connection) {
        if (request.method === "prompt.submit") throw new ChatCommitUnconfirmedError();
        throw new Error("Hermes chat generation changed.");
      }
      if (authorizeSettlement !== undefined && OWNED_SESSION_REQUEST_METHODS.has(request.method)
        && !authorizeSettlement()) {
        if (request.method === "prompt.submit") {
          this.#resetGeneration(generation);
          throw new ChatCommitUnconfirmedError();
        }
        throw new Error("Hermes live session ownership changed.");
      }
      this.#observeRequestUsage(request);
      return result;
    } catch (error) {
      if ((request.method === "session.create" || request.method === "session.resume")
        && error instanceof HermesChatTransportError && error.code === "timed_out"
        && generation === this.#generation) {
        try { await connection.close(); } finally { this.#upstreamUnavailable(generation); }
      }
      if (request.method === "prompt.submit" && promptCommitCouldBeUnconfirmed(error)) {
        // A malformed/ambiguous success can leave the live session running even
        // though the downstream socket received no authoritative result. Reset
        // the shared generation before reporting ambiguity: this releases all
        // Office leases synchronously, closes every close-on-disconnect Hermes
        // session, and makes a replacement resume wait for reset completion.
        this.#resetGeneration(generation);
        throw new ChatCommitUnconfirmedError();
      }
      throw error;
    }
  }

  flushLiveSession(liveSessionId: string): void {
    const buffered = this.#takeBuffered(liveSessionId);
    const owner = this.#coordinator.ownerForLive(liveSessionId);
    if (owner === undefined) return;
    const subscriber = this.#subscribers.get(owner);
    if (subscriber === undefined || buffered === undefined) return;
    if (buffered.dropped) {
      try {
        subscriber.onEvent({
          type: "error", sessionId: liveSessionId,
          payload: { status: "resync_required", message: "Early Hermes events exceeded the Office buffer. Reload session history." },
        });
      } catch { /* One Browser listener cannot break shared upstream routing. */ }
      return;
    }
    for (const event of buffered.events) {
      try { subscriber.onEvent(event); }
      catch { /* Continue delivering the remaining bounded batch. */ }
    }
  }

  discardBufferedSession(liveSessionId: string): void {
    this.#discardBuffered(liveSessionId);
    this.#droppedUnbound.delete(liveSessionId);
  }

  closeOwnerSessions(owner: ChatSessionOwner): Promise<boolean> {
    const previous = this.#ownerCleanup.get(owner);
    this.#cleanupEpoch += 1;
    let operation: Promise<boolean>;
    operation = (async () => {
      if (previous !== undefined) await previous.catch(() => false);
      if (!await this.#waitForSessionStarts(owner)) {
        // A start that outlives the Hermes request bound has an unknowable live
        // identity. Only this ambiguous fallback terminalizes the shared
        // generation; normal late results settle and are closed owner-locally.
        await this.#resetGeneration(this.#generation);
      } else {
        // The gateway settles only after binding or releasing every claim, so
        // live leases can now be targeted and pre-request claims can be dropped.
        this.#coordinator.releaseUnboundOwnerLeases(owner);
      }
      for (const lease of this.#coordinator.ownedSessionLeases(owner)) {
        const outcome = await this.#closeLease(owner, lease, 2);
        if (!outcome.completed && outcome.joined) {
          // A Browser may disconnect while its explicit close owns the live-ID
          // reservation. Join that authoritative operation first; if it failed
          // after detachment, retry owner cleanup without the stale Browser
          // authorization callback before declaring the shared state ambiguous.
          const unresolved = this.#coordinator.ownedSessionLeases(owner)
            .find((candidate) => candidate.token === lease.token);
          if (unresolved !== undefined) await this.#closeLease(owner, unresolved, 2);
        }
      }
      if (this.#coordinator.ownedSessionLeases(owner).length > 0) {
        await this.#resetGeneration(this.#generation);
      }
      return this.#coordinator.ownedSessionLeases(owner).length === 0;
    })().finally(() => {
      this.#cleanupOperations.delete(operation);
      if (this.#ownerCleanup.get(owner) === operation) this.#ownerCleanup.delete(owner);
    });
    this.#ownerCleanup.set(owner, operation);
    this.#cleanupOperations.add(operation);
    return operation;
  }

  async readStableHistory<T>(read: () => Promise<T>): Promise<T> {
    while (true) {
      await this.#waitForCleanup();
      await this.#resetting;
      if (this.#cleanupOperations.size === 0) break;
    }
    const generation = this.#generation;
    const cleanupEpoch = this.#cleanupEpoch;
    const result = await read();
    if (this.#resetting !== undefined || generation !== this.#generation
      || this.#cleanupOperations.size > 0 || cleanupEpoch !== this.#cleanupEpoch) {
      throw new Error("Hermes chat state changed during history read.");
    }
    return result;
  }

  async #waitForCleanup(): Promise<void> {
    while (this.#cleanupOperations.size > 0) {
      await Promise.allSettled([...this.#cleanupOperations]);
    }
  }

  async #waitForSessionStarts(owner: ChatSessionOwner): Promise<boolean> {
    const pending = [...(this.#pendingSessionStarts.get(owner) ?? [])];
    if (pending.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#pendingSessionSettlementMs);
      timer.unref();
    });
    const settled = Promise.all(pending.map((start) => start.promise)).then(() => true);
    const completed = await Promise.race([settled, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return completed;
  }

  async closeOwnedSession(
    owner: ChatSessionOwner,
    sessionId: string,
    authorize?: () => boolean,
  ): Promise<HermesChatResult> {
    const lease = this.#coordinator.leaseForSession(owner, sessionId);
    if (lease === undefined) {
      throw new Error("Hermes session is not owned by this Office connection.");
    }
    if (lease.liveSessionIds.length === 0) {
      // A durable-only lease represents create/resume I/O that has not yet
      // returned its authoritative live id. Closing nothing must not release
      // that pending claim or report a synthetic success.
      throw new Error(lease.pending ? "Hermes session identity is still pending." : "Hermes live session is unavailable.");
    }
    const outcome = await this.#closeLease(owner, lease, 2, sessionId, authorize);
    if (!outcome.completed) throw new Error("Hermes session close could not be confirmed.");
    return outcome.targetResult ?? { method: "session.close", value: { closed: true } };
  }

  async closeDuplicateSession(liveSessionId: string): Promise<"closed" | "known"> {
    this.discardBufferedSession(liveSessionId);
    const closeToken = this.#coordinator.claimUnownedLiveClose(liveSessionId);
    if (closeToken === undefined) return "known";
    let generation = this.#generation;
    try {
      const connection = await this.#ensureConnection();
      generation = this.#generation;
      const result = await connection.request({ method: "session.close", params: { session_id: liveSessionId } });
      if (generation !== this.#generation || connection !== this.#connection || typeof result.value.closed !== "boolean") {
        throw new Error("Hermes duplicate session close was not authoritative.");
      }
      this.discardBufferedSession(liveSessionId);
      return "closed";
    } catch (error) {
      if (generation === this.#generation) this.#resetGeneration(generation);
      throw error;
    } finally {
      this.#coordinator.finishUnownedLiveClose(liveSessionId, closeToken);
    }
  }

  resetAmbiguousSessionResult(): void {
    this.#resetGeneration(this.#generation);
  }

  async #closeLease(
    owner: ChatSessionOwner,
    lease: ChatSessionLeaseSnapshot,
    maxAttempts: number,
    targetSessionId?: string,
    authorize?: () => boolean,
  ): Promise<LeaseCloseResult> {
    const existing = this.#leaseCloseOperations.get(lease.token);
    if (existing !== undefined) {
      return closeResult(await existing, targetSessionId, true);
    }
    const closeToken = this.#coordinator.claimOwnedLeaseClose(owner, lease);
    if (closeToken === undefined) return { completed: false, results: new Map(), joined: false };
    let operation: Promise<LeaseCloseOperationResult>;
    operation = (async () => {
      const remaining = new Set(lease.liveSessionIds);
      const results = new Map<string, HermesChatResult>();
      for (let attempt = 0; attempt < maxAttempts && remaining.size > 0; attempt += 1) {
        for (const liveId of [...remaining]) {
          this.discardBufferedSession(liveId);
          try {
            const result = await this.#requestUnchecked(
              { method: "session.close", params: { session_id: liveId } }, undefined, authorize,
            );
            if (typeof result.value.closed !== "boolean") continue;
            remaining.delete(liveId);
            results.set(liveId, result);
          } catch { /* Keep the whole lease fail-closed and retry unresolved IDs. */ }
        }
      }
      if (remaining.size > 0) return { completed: false, results };
      this.#coordinator.releaseLease(owner, lease.token);
      for (const liveId of lease.liveSessionIds) this.discardBufferedSession(liveId);
      return { completed: true, results };
    })().finally(() => {
      if (this.#leaseCloseOperations.get(lease.token) === operation) {
        this.#leaseCloseOperations.delete(lease.token);
      }
      this.#coordinator.finishOwnedLeaseClose(lease, closeToken);
    });
    this.#leaseCloseOperations.set(lease.token, operation);
    return closeResult(await operation, targetSessionId, false);
  }

  async close(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#generation += 1;
    const connection = this.#connection;
    const resetting = this.#resetting;
    this.#connection = undefined;
    this.#connecting = undefined;
    this.#resetting = undefined;
    this.#clearBuffered();
    try {
      await connection?.close();
      await resetting;
    } finally {
      this.#coordinator.releaseAll();
      this.#subscribers.clear();
    }
  }

  async #ensureConnection(): Promise<HermesChatConnection> {
    if (this.#resetting !== undefined) await this.#resetting;
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    if (this.#connection !== undefined && !this.#connection.closed) return this.#connection;
    if (this.#connection?.closed === true) {
      this.#upstreamUnavailable(this.#generation);
      throw new Error("Hermes chat connection closed.");
    }
    if (this.#connecting !== undefined) return await this.#connecting;
    const generation = ++this.#generation;
    const connecting = (async () => {
      const transport = this.#runtimeSource.chat({ maxEventBytes: this.#maxEventBytes });
      const connection = await transport.connect(
        (event) => this.#routeEvent(generation, event),
        () => this.#upstreamUnavailable(generation),
      );
      if (this.#stopping || generation !== this.#generation) {
        await connection.close();
        throw new Error("Hermes chat generation changed.");
      }
      this.#connection = connection;
      return connection;
    })();
    this.#connecting = connecting;
    try { return await connecting; }
    catch (error) {
      if (!this.#stopping && generation === this.#generation) this.#upstreamUnavailable(generation);
      throw error;
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
    }
  }

  #routeEvent(generation: number, event: HermesChatEvent): void {
    if (this.#stopping || generation !== this.#generation || event.sessionId === undefined) return;
    // Count once at the shared choke point (before fan-out or unbound buffering).
    this.#observeEventUsage(event);
    const owner = this.#coordinator.ownerForLive(event.sessionId);
    if (owner !== undefined) {
      try { this.#subscribers.get(owner)?.onEvent(event); }
      catch { /* One Browser listener cannot break shared upstream routing. */ }
      return;
    }
    this.#bufferUnbound(event.sessionId, event);
  }

  /**
   * Records prompt/steer input size after Hermes acknowledged the request.
   * Never stores message text — only estimated token counts.
   */
  #observeRequestUsage(request: HermesChatRequest): void {
    if (this.#usage === undefined) return;
    try {
      if (request.method !== "prompt.submit" && request.method !== "session.steer") return;
      const text = typeof request.params?.text === "string" ? request.params.text : "";
      if (text.length === 0) return;
      const sessionId = typeof request.params?.session_id === "string" ? request.params.session_id : undefined;
      const profile = (sessionId === undefined ? undefined : this.#coordinator.profileForLive(sessionId)) ?? "default";
      this.#usage.record({
        profile,
        tokensIn: estimateTokensFromText(text),
        estimated: true,
      });
    } catch {
      /* Token stats must never break chat streaming. */
    }
  }

  /**
   * Records assistant output on message.complete. Prefers real token fields
   * from Hermes when present; otherwise estimates from character length.
   */
  #observeEventUsage(event: HermesChatEvent): void {
    if (this.#usage === undefined) return;
    try {
      if (event.type !== "message.complete") return;
      const role = typeof event.payload.role === "string" ? event.payload.role : "assistant";
      if (role === "user" || role === "tool" || role === "system") return;
      const profile = event.profile
        ?? (event.sessionId === undefined ? undefined : this.#coordinator.profileForLive(event.sessionId))
        ?? "default";
      // Prefer real completion/output counts when Hermes supplies them. Input is
      // already approximated on confirmed prompt.submit, so do not also apply
      // real prompt_tokens here (would double-count the same turn).
      const tokensOut = finiteNonNegativeInt(event.payload.tokensOut);
      if (tokensOut !== undefined) {
        this.#usage.record({ profile, tokensOut, estimated: false });
        return;
      }
      const text = typeof event.payload.text === "string" ? event.payload.text : "";
      if (text.length === 0) return;
      this.#usage.record({
        profile,
        tokensOut: estimateTokensFromText(text),
        estimated: true,
      });
    } catch {
      /* Token stats must never break chat streaming. */
    }
  }

  #bufferUnbound(liveSessionId: string, event: HermesChatEvent): void {
    // Once any prefix was evicted, later fragments cannot reconstruct a safe
    // stream. Preserve the tombstone until bind instead of buffering a suffix.
    if (this.#droppedUnbound.has(liveSessionId)) return;
    let buffered = this.#unbound.get(liveSessionId);
    if (buffered === undefined) {
      if (this.#unbound.size >= MAX_UNBOUND_SESSIONS) {
        const oldest = this.#unbound.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          this.#discardBuffered(oldest);
          if (!this.#markDropped(oldest)) return;
        }
      }
      buffered = { events: [], bytes: 0, dropped: false };
      this.#unbound.set(liveSessionId, buffered);
    }
    if (buffered.dropped) return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(event)); } catch { bytes = this.#maxEventBytes + 1; }
    if (bytes > this.#maxEventBytes || buffered.events.length >= MAX_EVENTS_PER_SESSION
      || this.#unboundEventCount >= MAX_UNBOUND_EVENTS || this.#unboundBytes + bytes > MAX_UNBOUND_BYTES) {
      this.#unboundEventCount -= buffered.events.length;
      this.#unboundBytes -= buffered.bytes;
      buffered.events = [];
      buffered.bytes = 0;
      buffered.dropped = true;
      return;
    }
    buffered.events.push(event);
    buffered.bytes += bytes;
    this.#unboundEventCount += 1;
    this.#unboundBytes += bytes;
  }

  #takeBuffered(liveSessionId: string): BufferedEvents | undefined {
    const buffered = this.#unbound.get(liveSessionId);
    if (buffered !== undefined) this.#discardBuffered(liveSessionId);
    const wasDropped = this.#droppedUnbound.delete(liveSessionId);
    // Tombstone precedence is defensive: never deliver a partial suffix even
    // if an older process version or race left both representations present.
    return wasDropped ? { events: [], bytes: 0, dropped: true } : buffered;
  }

  #discardBuffered(liveSessionId: string): void {
    const buffered = this.#unbound.get(liveSessionId);
    if (buffered === undefined) return;
    this.#unbound.delete(liveSessionId);
    this.#unboundEventCount -= buffered.events.length;
    this.#unboundBytes -= buffered.bytes;
  }

  #clearBuffered(): void {
    this.#unbound.clear();
    this.#droppedUnbound.clear();
    this.#unboundEventCount = 0;
    this.#unboundBytes = 0;
  }

  #markDropped(liveSessionId: string): boolean {
    if (this.#droppedUnbound.has(liveSessionId)) return true;
    if (this.#droppedUnbound.size >= MAX_UNBOUND_SESSIONS * 2) {
      this.#resetGeneration(this.#generation);
      return false;
    }
    this.#droppedUnbound.add(liveSessionId);
    return true;
  }

  #resetGeneration(generation: number): Promise<void> {
    if (this.#resetting !== undefined) return this.#resetting;
    if (this.#stopping || generation !== this.#generation) return Promise.resolve();
    const connection = this.#connection;
    const connecting = this.#connecting;
    this.#upstreamUnavailable(generation);
    let resetting: Promise<void> | undefined;
    resetting = (async () => {
      try {
        if (connection !== undefined) await connection.close();
        else if (connecting !== undefined) {
          try { await connecting; } catch { /* A stale connect closes itself. */ }
        }
      } catch { /* The generation is already terminal and fail-closed. */ }
      finally { if (this.#resetting === resetting) this.#resetting = undefined; }
    })();
    this.#resetting = resetting;
    return resetting;
  }

  #upstreamUnavailable(generation: number): void {
    if (this.#stopping || generation !== this.#generation) return;
    this.#generation += 1;
    this.#connection = undefined;
    this.#connecting = undefined;
    this.#clearBuffered();
    const affected = new Map<ChatSessionOwner, string[]>();
    for (const owner of this.#subscribers.keys()) affected.set(owner, this.#coordinator.ownedLiveSessionIds(owner));
    this.#coordinator.releaseAll();
    for (const [owner, subscriber] of this.#subscribers) {
      try { subscriber.onUnavailable(affected.get(owner) ?? []); }
      catch { /* Every subscriber still receives an independent terminal signal. */ }
    }
  }
}

function promptCommitCouldBeUnconfirmed(error: unknown): boolean {
  if (error instanceof ChatCommitUnconfirmedError) return true;
  if (!(error instanceof HermesChatTransportError)) return true;
  if (error.code === "invalid_request" || error.code === "connection_failed") return false;
  return error.code !== "backend_rejected" || error.rpcCode === undefined;
}

function closeResult(
  operation: LeaseCloseOperationResult,
  targetSessionId: string | undefined,
  joined: boolean,
): LeaseCloseResult {
  const targetResult = targetSessionId === undefined ? undefined : operation.results.get(targetSessionId);
  return {
    ...operation,
    joined,
    ...(targetResult === undefined ? {} : { targetResult }),
  };
}

function finiteNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return undefined;
  return Math.floor(value);
}
