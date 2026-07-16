import { randomBytes } from "node:crypto";
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
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_APPROVAL_QUEUE = 8;
const MAX_APPROVAL_SESSIONS = 128;

export interface ChatGatewayLimits {
  maxInFlight: number;
  maxQueue: number;
  socketRateCapacity: number;
  socketRatePerSecond: number;
  approvalTtlMs: number;
  maxBufferedBytes: number;
  maxApprovalQueue: number;
}

const DEFAULT_LIMITS: ChatGatewayLimits = {
  maxInFlight: MAX_IN_FLIGHT,
  maxQueue: MAX_QUEUE,
  socketRateCapacity: RATE_CAPACITY,
  socketRatePerSecond: RATE_PER_SECOND,
  approvalTtlMs: APPROVAL_TTL_MS,
  maxBufferedBytes: MAX_BUFFERED_BYTES,
  maxApprovalQueue: MAX_APPROVAL_QUEUE,
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

type PendingResponseState = "pending" | "claimed" | "consumed";
interface PendingResponse {
  createdAt: number;
  createdOrder: number;
  expiresAt: number;
  state: PendingResponseState;
}
interface PendingApproval {
  id: string;
  choices: ReadonlySet<string>;
  event: HermesChatEvent;
  state: PendingResponseState;
  createdAt?: number;
  createdOrder?: number;
  expiresAt?: number;
}
type PendingClaim =
  | { kind: "approval"; key: string; entry: PendingApproval }
  | { kind: "clarification"; key: string; entry: PendingResponse };

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
  const limits = {
    ...DEFAULT_LIMITS,
    ...dependencies.limits,
    maxBufferedBytes: Math.max(maxJsonBytes, dependencies.limits?.maxBufferedBytes ?? MAX_BUFFERED_BYTES),
  };
  let chatTransport: ReturnType<HermesRuntimeSource["chat"]>;
  try { chatTransport = runtimeSource.chat({ maxEventBytes: maxJsonBytes }); }
  catch { client.close(1013, "Hermes runtime unavailable"); return; }

  const queued: Array<{ body: string; receivedAt: number; receivedOrder: number }> = [];
  const pendingApprovals = new Map<string, PendingApproval[]>();
  const pendingClarifications = new Map<string, PendingResponse>();
  let upstream: Awaited<ReturnType<ReturnType<HermesRuntimeSource["chat"]>["connect"]>> | undefined;
  let closed = false;
  let inFlight = 0;
  let chronology = 0;
  let rateTokens = limits.socketRateCapacity;
  let rateUpdatedAt = now();

  const closeForBackpressure = (): void => {
    if (!closed && client.readyState === WebSocket.OPEN) {
      client.close(1013, "Client too slow; reload history");
    }
  };

  const sendWire = (body: string): boolean => {
    if (closed || client.readyState !== WebSocket.OPEN) return false;
    const buffered = typeof client.bufferedAmount === "number" && Number.isFinite(client.bufferedAmount)
      ? Math.max(0, client.bufferedAmount)
      : limits.maxBufferedBytes + 1;
    if (buffered + Buffer.byteLength(body) > limits.maxBufferedBytes) {
      closeForBackpressure();
      return false;
    }
    try {
      // `ws` delegates to Node's socket write callback, which can report
      // success as either `undefined` or `null` at runtime despite its type.
      client.send(body, (error) => { if (error != null) closeForBackpressure(); });
      return true;
    } catch {
      closeForBackpressure();
      return false;
    }
  };

  const send = (value: unknown): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    let body: string;
    try { body = JSON.stringify(value); } catch { return; }
    if (Buffer.byteLength(body) <= maxJsonBytes) { sendWire(body); return; }
    if (typeof value === "object" && value !== null && "id" in value) {
      const id = (value as { id?: unknown }).id;
      const fallback = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "Office response exceeded the wire budget." } });
      if (Buffer.byteLength(fallback) <= maxJsonBytes) sendWire(fallback);
    }
  };

  const processFrame = async (body: string, receivedAt: number, receivedOrder: number): Promise<void> => {
    let frame: unknown;
    try { frame = JSON.parse(body); } catch { client.close(1007, "Invalid JSON"); return; }
    if (!isRpcRequest(frame)) { client.close(1008, "Invalid RPC request"); return; }
    let claim: PendingClaim | undefined;
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
        const approvalId = typeof frame.params?.approval_id === "string" ? frame.params.approval_id : "";
        const queue = targetId === undefined ? undefined : pendingApprovals.get(targetId);
        const pending = queue?.[0];
        if (pending === undefined || pending.createdAt === undefined || pending.createdOrder === undefined || pending.expiresAt === undefined || pending.id !== approvalId || pending.state !== "pending" || receivedOrder < pending.createdOrder || receivedAt < pending.createdAt || pending.expiresAt <= receivedAt || !pending.choices.has(choice)) {
          if (targetId !== undefined && pending?.id === approvalId && pending.expiresAt !== undefined && pending.expiresAt <= receivedAt) {
            const promoted = expireApproval(pendingApprovals, targetId, pending);
            if (promoted !== undefined) sendWire(serializeOfficeChatEvent(activateApproval(promoted, now(), ++chronology, limits.approvalTtlMs), maxJsonBytes));
          }
          sendRpcError(send, frame.id, -32004, "Pending approval was not found or has expired.");
          return;
        }
        pending.state = "claimed";
        claim = { kind: "approval", key: targetId!, entry: pending };
      }
      if (frame.method === "clarify.respond") {
        const requestId = typeof frame.params?.request_id === "string" ? frame.params.request_id : "";
        const pending = pendingClarifications.get(requestId);
        if (pending === undefined || pending.state !== "pending" || receivedOrder < pending.createdOrder || receivedAt < pending.createdAt || pending.expiresAt <= receivedAt) {
          if (pending?.expiresAt !== undefined && pending.expiresAt <= receivedAt) pendingClarifications.delete(requestId);
          sendRpcError(send, frame.id, -32004, "Pending clarification was not found.");
          return;
        }
        pending.state = "claimed";
        claim = { kind: "clarification", key: requestId, entry: pending };
      }
      const seed = frame.method === "session.create"
        ? await runtimeSource.globalInheritance?.().sessionCreateContext()
        : undefined;
      const result = await upstream!.request(
        { method: frame.method, ...upstreamRequestParams(frame.method, frame.params) },
        seed === undefined ? undefined : { sessionCreateSystemSeed: seed },
      );
      const promoted = consumeClaim(claim, pendingApprovals, pendingClarifications);
      if (promoted !== undefined) sendWire(serializeOfficeChatEvent(activateApproval(promoted, now(), ++chronology, limits.approvalTtlMs), maxJsonBytes));
      send({ jsonrpc: "2.0", id: frame.id, result: result.value });
    } catch {
      const promoted = restoreClaim(claim, pendingApprovals, pendingClarifications, closed, now());
      if (promoted !== undefined) sendWire(serializeOfficeChatEvent(activateApproval(promoted, now(), ++chronology, limits.approvalTtlMs), maxJsonBytes));
      sendRpcError(send, frame.id, -32000, "Hermes request failed.");
    }
  };

  const drain = (): void => {
    while (!closed && upstream !== undefined && inFlight < limits.maxInFlight && queued.length > 0) {
      const { body, receivedAt, receivedOrder } = queued.shift()!;
      inFlight += 1;
      void processFrame(body, receivedAt, receivedOrder).finally(() => { inFlight -= 1; drain(); });
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
    queued.push({ body: data.toString(), receivedAt: currentTime, receivedOrder: ++chronology });
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
      const queue = pendingApprovals.get(event.sessionId) ?? [];
      if ((queue.length === 0 && pendingApprovals.size >= MAX_APPROVAL_SESSIONS) || queue.length >= limits.maxApprovalQueue) {
        sendWire(serializeOfficeChatEvent({ type: "error", sessionId: event.sessionId, payload: { status: "resync_required", message: "Approval queue overflow. Reload the session." } }, maxJsonBytes));
        client.close(1013, "Approval queue overflow; reload history");
        return;
      }
      const approval: PendingApproval = {
        id: `approval_${randomBytes(16).toString("base64url")}`,
        choices: new Set(choices), event, state: "pending",
      };
      queue.push(approval);
      pendingApprovals.set(event.sessionId, queue);
      if (queue.length === 1) sendWire(serializeOfficeChatEvent(activateApproval(approval, now(), ++chronology, limits.approvalTtlMs), maxJsonBytes));
      return;
    }
    if (event.type === "clarify.request" && typeof event.payload.requestId === "string") {
      const createdAt = now();
      const createdOrder = ++chronology;
      const existing = pendingClarifications.get(event.payload.requestId);
      if (existing?.state !== "claimed") {
        pendingClarifications.set(event.payload.requestId, { createdAt, createdOrder, expiresAt: createdAt + limits.approvalTtlMs, state: "pending" });
      }
      trimOldest(pendingClarifications, 128);
    }
    sendWire(serializeOfficeChatEvent(event, maxJsonBytes));
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

function consumeClaim(
  claim: PendingClaim | undefined,
  approvals: Map<string, PendingApproval[]>,
  clarifications: ReadonlyMap<string, PendingResponse>,
): PendingApproval | undefined {
  if (claim === undefined) return undefined;
  if (claim.kind === "approval") {
    const queue = approvals.get(claim.key);
    if (queue?.[0] !== claim.entry || claim.entry.state !== "claimed") return undefined;
    claim.entry.state = "consumed";
    queue.shift();
    if (queue.length === 0) { approvals.delete(claim.key); return undefined; }
    return queue[0]!;
  }
  const current = clarifications.get(claim.key);
  if (current === claim.entry && claim.entry.state === "claimed") claim.entry.state = "consumed";
  return undefined;
}

function restoreClaim(
  claim: PendingClaim | undefined,
  approvals: Map<string, PendingApproval[]>,
  clarifications: ReadonlyMap<string, PendingResponse>,
  closed: boolean,
  currentTime: number,
): PendingApproval | undefined {
  if (claim === undefined || closed) return undefined;
  if (claim.kind === "approval") {
    const queue = approvals.get(claim.key);
    if (queue?.[0] !== claim.entry || claim.entry.state !== "claimed") return undefined;
    if (claim.entry.expiresAt !== undefined && claim.entry.expiresAt > currentTime) { claim.entry.state = "pending"; return undefined; }
    return expireApproval(approvals, claim.key, claim.entry);
  }
  const current = clarifications.get(claim.key);
  if (claim.entry.expiresAt > currentTime && current === claim.entry && claim.entry.state === "claimed") claim.entry.state = "pending";
  return undefined;
}

function expireApproval(approvals: Map<string, PendingApproval[]>, key: string, entry: PendingApproval): PendingApproval | undefined {
  const queue = approvals.get(key);
  if (queue?.[0] !== entry) return undefined;
  queue.shift();
  if (queue.length === 0) { approvals.delete(key); return undefined; }
  return queue[0]!;
}

function upstreamRequestParams(method: HermesChatMethod, params: Record<string, unknown> | undefined): { params?: Record<string, unknown> } {
  if (params === undefined) return {};
  if (method !== "approval.respond") return { params };
  return { params: {
    ...(typeof params.session_id === "string" ? { session_id: params.session_id } : {}),
    ...(typeof params.choice === "string" ? { choice: params.choice } : {}),
  } };
}

function officeApprovalEvent(approval: PendingApproval): HermesChatEvent {
  return { ...approval.event, payload: { ...approval.event.payload, approvalId: approval.id } };
}

function activateApproval(approval: PendingApproval, createdAt: number, createdOrder: number, ttlMs: number): HermesChatEvent {
  approval.createdAt = createdAt;
  approval.createdOrder = createdOrder;
  approval.expiresAt = createdAt + ttlMs;
  approval.state = "pending";
  return officeApprovalEvent(approval);
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
