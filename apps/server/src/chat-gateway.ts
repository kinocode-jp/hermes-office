import { WebSocket } from "ws";
import type { Operation } from "@hermes-office/protocol";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HERMES_CHAT_METHODS, type HermesChatMethod } from "./hermes-chat.js";
import type { OfficeAuth, OfficeAuthSession } from "./office-auth.js";

const MAX_IN_FLIGHT = 4;
const MAX_QUEUE = 16;
const RATE_CAPACITY = 30;
const RATE_PER_SECOND = 10;
const APPROVAL_TTL_MS = 5 * 60_000;

export interface ChatGatewayDependencies {
  auth: OfficeAuth;
  officeSession: OfficeAuthSession;
  runtimeSource: HermesRuntimeSource;
  maxJsonBytes: number;
  deviceLimiter: ChatDeviceRateLimiter;
}

export class ChatDeviceRateLimiter {
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  consume(deviceId: string): boolean {
    const now = Date.now();
    const bucket = this.#buckets.get(deviceId) ?? { tokens: 60, updatedAt: now };
    bucket.tokens = Math.min(60, bucket.tokens + ((now - bucket.updatedAt) / 1_000) * 20);
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
  let chatTransport: ReturnType<HermesRuntimeSource["chat"]>;
  try { chatTransport = runtimeSource.chat(); }
  catch { client.close(1013, "Hermes runtime unavailable"); return; }

  const queued: string[] = [];
  const pendingApprovals = new Map<string, { choices: ReadonlySet<string>; expiresAt: number }>();
  const pendingClarifications = new Set<string>();
  let upstream: Awaited<ReturnType<ReturnType<HermesRuntimeSource["chat"]>["connect"]>> | undefined;
  let closed = false;
  let inFlight = 0;
  let rateTokens = RATE_CAPACITY;
  let rateUpdatedAt = Date.now();

  const send = (value: unknown): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    let body: string;
    try { body = JSON.stringify(value); } catch { return; }
    if (Buffer.byteLength(body) <= maxJsonBytes) client.send(body);
  };

  const processFrame = async (body: string): Promise<void> => {
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
        if (pending === undefined || pending.expiresAt <= Date.now() || !pending.choices.has(choice)) {
          sendRpcError(send, frame.id, -32004, "Pending approval was not found or has expired.");
          return;
        }
        pendingApprovals.delete(targetId!);
      }
      if (frame.method === "clarify.respond") {
        const requestId = typeof frame.params?.request_id === "string" ? frame.params.request_id : "";
        if (!pendingClarifications.delete(requestId)) {
          sendRpcError(send, frame.id, -32004, "Pending clarification was not found.");
          return;
        }
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
    while (!closed && upstream !== undefined && inFlight < MAX_IN_FLIGHT && queued.length > 0) {
      const body = queued.shift()!;
      inFlight += 1;
      void processFrame(body).finally(() => { inFlight -= 1; drain(); });
    }
  };

  client.on("message", (data, isBinary) => {
    if (isBinary) { client.close(1003, "Text frames only"); return; }
    const now = Date.now();
    rateTokens = Math.min(RATE_CAPACITY, rateTokens + ((now - rateUpdatedAt) / 1_000) * RATE_PER_SECOND);
    rateUpdatedAt = now;
    if (rateTokens < 1) { client.close(1008, "Chat rate limit exceeded"); return; }
    if (!deviceLimiter.consume(officeSession.principal.id)) { client.close(1008, "Device chat rate limit exceeded"); return; }
    rateTokens -= 1;
    if (queued.length >= MAX_QUEUE) { client.close(1013, "Chat queue is full"); return; }
    queued.push(data.toString());
    drain();
  });
  client.on("close", () => { closed = true; void upstream?.close(); });
  client.on("error", () => { closed = true; void upstream?.close(); });

  void chatTransport.connect((event) => {
    if (event.type === "approval.request" && event.sessionId !== undefined) {
      const choices = Array.isArray(event.payload.choices)
        ? event.payload.choices.filter((choice): choice is string => typeof choice === "string")
        : [];
      pendingApprovals.set(event.sessionId, { choices: new Set(choices), expiresAt: Date.now() + APPROVAL_TTL_MS });
      trimOldest(pendingApprovals, 128);
    }
    if (event.type === "clarify.request" && typeof event.payload.requestId === "string") {
      pendingClarifications.add(event.payload.requestId);
      trimOldest(pendingClarifications, 128);
    }
    send({ jsonrpc: "2.0", method: "event", params: event });
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
