import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesChatTransportError } from "./hermes-chat.js";
import type {
  HermesChatConnection,
  HermesChatEvent,
  HermesChatInternalRequestOptions,
  HermesChatRequest,
  HermesChatResult,
} from "./hermes-chat.js";
import { ChatSessionCoordinator, type ChatSessionOwner } from "./chat-session-coordinator.js";

const MAX_UNBOUND_SESSIONS = 64;
const MAX_UNBOUND_EVENTS = 128;
const MAX_EVENTS_PER_SESSION = 32;
const MAX_UNBOUND_BYTES = 256 * 1024;

export interface ChatHubSubscriber {
  onEvent(event: HermesChatEvent): void;
  onUnavailable(liveSessionIds: readonly string[]): void;
}

type BufferedEvents = {
  events: HermesChatEvent[];
  bytes: number;
  dropped: boolean;
};

/** One process-wide Hermes transport shared by every downstream Chat socket. */
export class ChatUpstreamHub {
  readonly #runtimeSource: HermesRuntimeSource;
  readonly #coordinator: ChatSessionCoordinator;
  readonly #maxEventBytes: number;
  readonly #subscribers = new Map<ChatSessionOwner, ChatHubSubscriber>();
  readonly #unbound = new Map<string, BufferedEvents>();
  readonly #droppedUnbound = new Set<string>();
  #unboundEventCount = 0;
  #unboundBytes = 0;
  #connection: HermesChatConnection | undefined;
  #connecting: Promise<HermesChatConnection> | undefined;
  #resetting: Promise<void> | undefined;
  #generation = 0;
  #stopping = false;

  constructor(runtimeSource: HermesRuntimeSource, coordinator: ChatSessionCoordinator, maxEventBytes: number) {
    this.#runtimeSource = runtimeSource;
    this.#coordinator = coordinator;
    this.#maxEventBytes = Math.max(4_096, maxEventBytes);
  }

  async attach(owner: ChatSessionOwner, subscriber: ChatHubSubscriber): Promise<void> {
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    this.#subscribers.set(owner, subscriber);
    try { await this.#ensureConnection(); }
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
  ): Promise<HermesChatResult> {
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    if (!this.#subscribers.has(owner) && this.#coordinator.ownedLiveSessionIds(owner).length === 0) {
      throw new Error("Chat owner is detached.");
    }
    const connection = await this.#ensureConnection();
    const generation = this.#generation;
    try {
      const result = await connection.request(request, internal);
      if (generation !== this.#generation || connection !== this.#connection) throw new Error("Hermes chat generation changed.");
      return result;
    } catch (error) {
      if ((request.method === "session.create" || request.method === "session.resume")
        && error instanceof HermesChatTransportError && error.code === "timed_out"
        && generation === this.#generation) {
        try { await connection.close(); } finally { this.#upstreamUnavailable(generation); }
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

  async closeOwnerSessions(owner: ChatSessionOwner): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const liveIds = this.#coordinator.ownedLiveSessionIds(owner);
      if (liveIds.length === 0) return true;
      for (const liveId of liveIds) {
        this.discardBufferedSession(liveId);
        try {
          const result = await this.request(owner, { method: "session.close", params: { session_id: liveId } });
          if (result.value.closed === true) {
            this.#coordinator.releaseSession(owner, liveId);
            this.discardBufferedSession(liveId);
          }
        } catch { /* Keep the lease fail-closed and retry once. */ }
      }
    }
    return this.#coordinator.ownedLiveSessionIds(owner).length === 0;
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
    const owner = this.#coordinator.ownerForLive(event.sessionId);
    if (owner !== undefined) {
      try { this.#subscribers.get(owner)?.onEvent(event); }
      catch { /* One Browser listener cannot break shared upstream routing. */ }
      return;
    }
    this.#bufferUnbound(event.sessionId, event);
  }

  #bufferUnbound(liveSessionId: string, event: HermesChatEvent): void {
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
    return buffered ?? (wasDropped ? { events: [], bytes: 0, dropped: true } : undefined);
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
      this.#resetForBufferOverflow(this.#generation);
      return false;
    }
    this.#droppedUnbound.add(liveSessionId);
    return true;
  }

  #resetForBufferOverflow(generation: number): void {
    if (this.#stopping || generation !== this.#generation || this.#resetting !== undefined) return;
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
