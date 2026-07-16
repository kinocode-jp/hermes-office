import { WebSocket } from "ws";
import type { Operation } from "@hermes-office/protocol";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HERMES_CHAT_METHODS, type HermesChatEvent, type HermesChatMethod } from "./hermes-chat.js";
import type { OfficeAuth, OfficeAuthSession } from "./office-auth.js";

const MAX_IN_FLIGHT = 4;
const MAX_QUEUE = 16;
const RATE_CAPACITY = 30;
const RATE_PER_SECOND = 10;
const APPROVAL_TTL_MS = 5 * 60_000;

export interface ChatGatewayLimits {
  maxInFlight: number;
  maxQueue: number;
  socketRateCapacity: number;
  socketRatePerSecond: number;
  approvalTtlMs: number;
}

const DEFAULT_LIMITS: ChatGatewayLimits = {
  maxInFlight: MAX_IN_FLIGHT,
  maxQueue: MAX_QUEUE,
  socketRateCapacity: RATE_CAPACITY,
  socketRatePerSecond: RATE_PER_SECOND,
  approvalTtlMs: APPROVAL_TTL_MS,
};

export interface ChatGatewayDependencies {
  auth: OfficeAuth;
  officeSession: OfficeAuthSession;
  runtimeSource: HermesRuntimeSource;
  maxJsonBytes: number;
  deviceLimiter: ChatDeviceRateLimiter;
  limits?: Partial<ChatGatewayLimits>;
  now?: () => number;
}

export class ChatDeviceRateLimiter {
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();
  readonly #now: () => number;
  readonly #capacity: number;
  readonly #ratePerSecond: number;

  constructor(options: { now?: () => number; capacity?: number; ratePerSecond?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#capacity = options.capacity ?? 60;
    this.#ratePerSecond = options.ratePerSecond ?? 20;
  }

  consume(deviceId: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(deviceId) ?? { tokens: this.#capacity, updatedAt: now };
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + ((now - bucket.updatedAt) / 1_000) * this.#ratePerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    this.#buckets.set(deviceId, bucket);
    if (this.#buckets.size > 128) {
      const stale = [...this.#buckets].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
      if (stale !== undefined) this.#buckets.delete(stale[0]);
    }
    return true;
  }
}

export function handleOfficeChatConnection(client: WebSocket, dependencies: ChatGatewayDependencies): void {
  const { auth, officeSession, runtimeSource, maxJsonBytes, deviceLimiter } = dependencies;
  const now = dependencies.now ?? Date.now;
  const limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
  let chatTransport: ReturnType<HermesRuntimeSource["chat"]>;
  try { chatTransport = runtimeSource.chat({ maxEventBytes: maxJsonBytes }); }
  catch { client.close(1013, "Hermes runtime unavailable"); return; }

  const queued: Array<{ body: string; receivedAt: number }> = [];
  const pendingApprovals = new Map<string, { choices: ReadonlySet<string>; createdAt: number; expiresAt: number }>();
  const pendingClarifications = new Map<string, { createdAt: number; expiresAt: number }>();
  let upstream: Awaited<ReturnType<ReturnType<HermesRuntimeSource["chat"]>["connect"]>> | undefined;
  let closed = false;
  let inFlight = 0;
  let rateTokens = limits.socketRateCapacity;
  let rateUpdatedAt = now();

  const send = (value: unknown): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    let body: string;
    try { body = JSON.stringify(value); } catch { return; }
    if (Buffer.byteLength(body) <= maxJsonBytes) { client.send(body); return; }
    if (typeof value === "object" && value !== null && "id" in value) {
      const id = (value as { id?: unknown }).id;
      const fallback = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "Office response exceeded the wire budget." } });
      if (Buffer.byteLength(fallback) <= maxJsonBytes) client.send(fallback);
    }
  };

  const processFrame = async (body: string, receivedAt: number): Promise<void> => {
    let frame: unknown;
    try { frame = JSON.parse(body); } catch { client.close(1007, "Invalid JSON"); return; }
    if (!isRpcRequest(frame)) { client.close(1008, "Invalid RPC request"); return; }
    try {
      const access = auth.authorizeSession(officeSession, chatOperation(frame.method));
      if (!access.allowed) { sendRpcError(send, frame.id, -32003, "Operation is not permitted for this device."); return; }
      const targetId = chatTargetId(frame.method, frame.params);
      if (frame.method === "approval.respond") {
        const choice = typeof frame.params?.choice === "string" ? frame.params.choice : "";
        if (choice === "always" && !auth.authorizeSession(officeSession, "chat.approval.permanent").allowed) {
          sendRpcError(send, frame.id, -32003, "Permanent approval requires verified local owner access.");
          return;
        }
        const pending = targetId === undefined ? undefined : pendingApprovals.get(targetId);
        if (pending === undefined || receivedAt < pending.createdAt || pending.expiresAt <= receivedAt || !pending.choices.has(choice)) {
          if (pending?.expiresAt !== undefined && pending.expiresAt <= receivedAt) pendingApprovals.delete(targetId!);
          sendRpcError(send, frame.id, -32004, "Pending approval was not found or has expired.");
          return;
        }
        pendingApprovals.delete(targetId!);
      }
      if (frame.method === "clarify.respond") {
        const requestId = typeof frame.params?.request_id === "string" ? frame.params.request_id : "";
        const pending = pendingClarifications.get(requestId);
        if (pending === undefined || receivedAt < pending.createdAt || pending.expiresAt <= receivedAt) {
          if (pending?.expiresAt !== undefined && pending.expiresAt <= receivedAt) pendingClarifications.delete(requestId);
          sendRpcError(send, frame.id, -32004, "Pending clarification was not found.");
          return;
        }
        pendingClarifications.delete(requestId);
      }
      const seed = frame.method === "session.create"
        ? await runtimeSource.globalInheritance?.().sessionCreateContext()
        : undefined;
      const result = await upstream!.request(
        { method: frame.method, ...(frame.params === undefined ? {} : { params: frame.params }) },
        seed === undefined ? undefined : { sessionCreateSystemSeed: seed },
      );
      send({ jsonrpc: "2.0", id: frame.id, result: result.value });
    } catch {
      sendRpcError(send, frame.id, -32000, "Hermes request failed.");
    }
  };

  const drain = (): void => {
    while (!closed && upstream !== undefined && inFlight < limits.maxInFlight && queued.length > 0) {
      const { body, receivedAt } = queued.shift()!;
      inFlight += 1;
      void processFrame(body, receivedAt).finally(() => { inFlight -= 1; drain(); });
    }
  };

  client.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) { client.close(1003, "Text frames only"); return; }
    const currentTime = now();
    rateTokens = Math.min(limits.socketRateCapacity, rateTokens + ((currentTime - rateUpdatedAt) / 1_000) * limits.socketRatePerSecond);
    rateUpdatedAt = currentTime;
    if (rateTokens < 1) { client.close(1008, "Chat rate limit exceeded"); return; }
    if (!deviceLimiter.consume(officeSession.principal.id)) { client.close(1008, "Device chat rate limit exceeded"); return; }
    rateTokens -= 1;
    if (queued.length >= limits.maxQueue) { client.close(1013, "Chat queue is full"); return; }
    queued.push({ body: data.toString(), receivedAt: currentTime });
    drain();
  });
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    queued.length = 0;
    pendingApprovals.clear();
    pendingClarifications.clear();
    void upstream?.close();
  };
  client.on("close", shutdown);
  client.on("error", shutdown);

  void chatTransport.connect((event) => {
    if (event.type === "approval.request" && event.sessionId !== undefined) {
      const choices = Array.isArray(event.payload.choices)
        ? event.payload.choices.filter((choice): choice is string => typeof choice === "string")
        : [];
      const createdAt = now();
      pendingApprovals.set(event.sessionId, { choices: new Set(choices), createdAt, expiresAt: createdAt + limits.approvalTtlMs });
      trimOldest(pendingApprovals, 128);
    }
    if (event.type === "clarify.request" && typeof event.payload.requestId === "string") {
      const createdAt = now();
      pendingClarifications.set(event.payload.requestId, { createdAt, expiresAt: createdAt + limits.approvalTtlMs });
      trimOldest(pendingClarifications, 128);
    }
    if (client.readyState === WebSocket.OPEN) client.send(serializeOfficeChatEvent(event, maxJsonBytes));
  }).then(async (connection) => {
    upstream = connection;
    if (closed) { await connection.close(); return; }
    send({ jsonrpc: "2.0", method: "office.ready", params: {} });
    drain();
  }).catch(() => client.close(1013, "Hermes chat unavailable"));
}

function isRpcRequest(value: unknown): value is { id: string | number; method: HermesChatMethod; params?: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.jsonrpc === "2.0"
    && (typeof frame.id === "string" || typeof frame.id === "number")
    && typeof frame.method === "string"
    && HERMES_CHAT_METHODS.includes(frame.method as HermesChatMethod)
    && (frame.params === undefined || (typeof frame.params === "object" && frame.params !== null && !Array.isArray(frame.params)));
}

function chatOperation(method: HermesChatMethod): Operation {
  if (method === "session.create" || method === "session.resume") return "chat.session.create";
  if (method === "session.close") return "chat.session.archive";
  if (method === "session.interrupt") return "chat.run.cancel";
  return "chat.message.send";
}

function chatTargetId(method: HermesChatMethod, params: Record<string, unknown> | undefined): string | undefined {
  if (method === "session.create" || method === "clarify.respond") return undefined;
  return typeof params?.session_id === "string" ? params.session_id : undefined;
}

function sendRpcError(send: (value: unknown) => void, id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function trimOldest<T>(collection: Map<string, T> | Set<string>, maximum: number): void {
  while (collection.size > maximum) {
    const oldest = collection.keys().next();
    if (oldest.done) return;
    collection.delete(oldest.value);
  }
}

/** Serializes one upstream event within the exact Office wire budget. */
export function serializeOfficeChatEvent(event: HermesChatEvent, maxBytes: number): string {
  const envelope = (params: HermesChatEvent): unknown => ({ jsonrpc: "2.0", method: "event", params });
  const exact = JSON.stringify(envelope(event));
  if (Buffer.byteLength(exact) <= maxBytes) return exact;

  const payload: HermesChatEvent["payload"] = { ...event.payload, truncated: true };
  const truncated: HermesChatEvent = { ...event, payload };
  const fields = (["text", "summary", "description", "command", "question", "message"] as const)
    .filter((field) => typeof payload[field] === "string")
    .sort((left, right) => Buffer.byteLength(payload[right] as string) - Buffer.byteLength(payload[left] as string));
  for (const field of fields) {
    const original = payload[field];
    if (typeof original !== "string") continue;
    const points = Array.from(original);
    payload[field] = "";
    let candidate = JSON.stringify(envelope(truncated));
    if (Buffer.byteLength(candidate) > maxBytes) continue;
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      payload[field] = points.slice(0, middle).join("");
      candidate = JSON.stringify(envelope(truncated));
      if (Buffer.byteLength(candidate) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    payload[field] = points.slice(0, low).join("");
    return JSON.stringify(envelope(truncated));
  }

  const resync: HermesChatEvent = {
    type: "error",
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.profile === undefined ? {} : { profile: event.profile }),
    payload: {
      status: "resync_required",
      message: "A Hermes event exceeded the Office wire budget. Reload session history.",
      originalType: event.type,
      truncated: true,
    },
  };
  const fallback = JSON.stringify(envelope(resync));
  if (Buffer.byteLength(fallback) <= maxBytes) return fallback;
  return JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "error", payload: { status: "resync_required", truncated: true } } });
}
