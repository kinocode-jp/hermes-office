import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { HermesChatTransport, HermesHistoryDto, HermesHistoryMessageDto } from "./hermes-chat.js";

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 50;
const CURSOR_SECRET = randomBytes(32);

export const DEFAULT_HISTORY_AGGREGATE_LIMITS: HistoryAggregateLimits = {
  maxPages: 40,
  maxMessages: 500,
  maxBytes: 8 * 1024 * 1024,
};

export type HistoryTruncationReason = "page_limit" | "message_limit" | "byte_limit";
export type HistoryAggregateLimits = { maxPages: number; maxMessages: number; maxBytes: number };
type HistoryCursorState = { offset: number; pages: number; messages: number; bytes: number };

export interface OfficeHistoryPage extends Omit<HermesHistoryDto, "pagination"> {
  pagination: {
    limit: number;
    offset: number;
    returned: number;
    hasMore: boolean;
    nextCursor?: string;
    pageLimitedByBytes: boolean;
    truncated: boolean;
    partial: boolean;
    truncationReason?: HistoryTruncationReason;
    cumulative: { pages: number; messages: number; bytes: number };
    limits: HistoryAggregateLimits;
  };
}

export class HistoryHttpInputError extends Error {}

/** Fetches one response-bounded page while enforcing signed cumulative limits. */
export async function fetchOfficeHistoryPage(
  chat: HermesChatTransport,
  requestUrl: URL,
  sessionId: string,
  maxResponseBytes: number,
  limits: HistoryAggregateLimits = DEFAULT_HISTORY_AGGREGATE_LIMITS,
): Promise<OfficeHistoryPage> {
  validateQuery(requestUrl);
  validateLimits(limits);
  const profile = requestUrl.searchParams.get("profile") ?? "default";
  const limit = parseLimit(requestUrl.searchParams.get("limit"));
  const cursor = decodeCursor(requestUrl.searchParams.get("cursor"), limits);
  const history = await chat.fetchHistory({ sessionId, profile, limit, offset: cursor.offset });
  return fitPage(history, limit, cursor, maxResponseBytes, limits);
}

function fitPage(
  history: HermesHistoryDto,
  limit: number,
  cursor: HistoryCursorState,
  maxResponseBytes: number,
  limits: HistoryAggregateLimits,
): OfficeHistoryPage {
  const messages: HermesHistoryMessageDto[] = [];
  let addedBytes = 0;
  let truncationReason: HistoryTruncationReason | undefined;
  const upstreamMayHaveMore = history.pagination.returned >= limit;
  for (const message of history.messages) {
    if (cursor.messages + messages.length >= limits.maxMessages) { truncationReason = "message_limit"; break; }
    const messageBytes = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (cursor.bytes + addedBytes + messageBytes > limits.maxBytes) { truncationReason = "byte_limit"; break; }
    const candidateMessages = messages.concat(message);
    const candidateBytes = addedBytes + messageBytes;
    const candidateHasMore = candidateMessages.length < history.messages.length || upstreamMayHaveMore;
    const candidate = makePage(history, candidateMessages, limit, cursor, candidateBytes, candidateHasMore, false, undefined, limits);
    if (Buffer.byteLength(JSON.stringify(candidate)) > maxResponseBytes) break;
    messages.push(message);
    addedBytes = candidateBytes;
  }

  const pageLimitedByBytes = messages.length < history.messages.length && truncationReason === undefined;
  const moreAvailable = messages.length < history.messages.length || upstreamMayHaveMore;
  const cumulative = { pages: cursor.pages + 1, messages: cursor.messages + messages.length, bytes: cursor.bytes + addedBytes };
  if (moreAvailable && truncationReason === undefined) {
    if (cumulative.pages >= limits.maxPages) truncationReason = "page_limit";
    else if (cumulative.messages >= limits.maxMessages) truncationReason = "message_limit";
    else if (cumulative.bytes >= limits.maxBytes) truncationReason = "byte_limit";
  }
  const truncated = moreAvailable && truncationReason !== undefined;
  const hasMore = moreAvailable && !truncated;
  if (messages.length === 0 && (hasMore || (truncated && cursor.messages === 0))) {
    throw new Error("A single history message exceeds the Office response or aggregate budget.");
  }
  const page = makePage(history, messages, limit, cursor, addedBytes, hasMore, pageLimitedByBytes, truncated ? truncationReason : undefined, limits);
  if (Buffer.byteLength(JSON.stringify(page)) > maxResponseBytes) throw new Error("History metadata exceeds the Office response budget.");
  return page;
}

function makePage(
  history: HermesHistoryDto,
  messages: HermesHistoryMessageDto[],
  limit: number,
  cursor: HistoryCursorState,
  addedBytes: number,
  hasMore: boolean,
  pageLimitedByBytes: boolean,
  truncationReason: HistoryTruncationReason | undefined,
  limits: HistoryAggregateLimits,
): OfficeHistoryPage {
  const nextOffset = messages.length === 0 ? cursor.offset : Math.max(cursor.offset + messages.length, messages.at(-1)!.index + 1);
  const cumulative = { pages: cursor.pages + 1, messages: cursor.messages + messages.length, bytes: cursor.bytes + addedBytes };
  const truncated = truncationReason !== undefined;
  return {
    sessionId: history.sessionId,
    profile: history.profile,
    messages,
    pagination: {
      limit,
      offset: cursor.offset,
      returned: messages.length,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursor({ offset: nextOffset, ...cumulative }) } : {}),
      pageLimitedByBytes,
      truncated,
      partial: truncated && cumulative.messages > 0,
      ...(truncationReason === undefined ? {} : { truncationReason }),
      cumulative,
      limits,
    },
  };
}

function validateQuery(url: URL): void {
  const allowed = new Set(["profile", "limit", "cursor"]);
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.has(key) || seen.has(key)) throw new HistoryHttpInputError("History query parameters are invalid.");
    seen.add(key);
  }
}

function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_PAGE_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) throw new HistoryHttpInputError(`History limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
  return parsed;
}

function encodeCursor(state: HistoryCursorState): string {
  const payload = `v2:${state.offset}:${state.pages}:${state.messages}:${state.bytes}`;
  const signature = createHmac("sha256", CURSOR_SECRET).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${signature}`, "utf8").toString("base64url");
}

function decodeCursor(value: string | null, limits: HistoryAggregateLimits): HistoryCursorState {
  if (value === null) return { offset: 0, pages: 0, messages: 0, bytes: 0 };
  if (value.length > 256) throw new HistoryHttpInputError("History cursor is invalid.");
  let decoded: string;
  try { decoded = Buffer.from(value, "base64url").toString("utf8"); }
  catch { throw new HistoryHttpInputError("History cursor is invalid."); }
  const match = /^v2:(0|[1-9][0-9]{0,6}):(0|[1-9][0-9]{0,2}):(0|[1-9][0-9]{0,5}):(0|[1-9][0-9]{0,8}):([A-Za-z0-9_-]{43})$/.exec(decoded);
  if (match === null) throw new HistoryHttpInputError("History cursor is invalid.");
  const payload = decoded.slice(0, decoded.lastIndexOf(":"));
  const expected = createHmac("sha256", CURSOR_SECRET).update(payload).digest();
  const actual = Buffer.from(match[5]!, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HistoryHttpInputError("History cursor is invalid.");
  const state = { offset: Number(match[1]), pages: Number(match[2]), messages: Number(match[3]), bytes: Number(match[4]) };
  if (!Object.values(state).every(Number.isSafeInteger) || state.offset > 1_000_000 || state.pages >= limits.maxPages || state.messages >= limits.maxMessages || state.bytes >= limits.maxBytes) {
    throw new HistoryHttpInputError("History cursor is outside the allowed continuation range.");
  }
  return state;
}

function validateLimits(limits: HistoryAggregateLimits): void {
  if (!Number.isSafeInteger(limits.maxPages) || limits.maxPages < 1 || limits.maxPages > 100
    || !Number.isSafeInteger(limits.maxMessages) || limits.maxMessages < 1 || limits.maxMessages > 5_000
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1_024 || limits.maxBytes > 32 * 1024 * 1024) {
    throw new Error("History aggregate limits are invalid.");
  }
}
