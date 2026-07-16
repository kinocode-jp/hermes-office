import type { HermesChatTransport, HermesHistoryDto } from "./hermes-chat.js";

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 50;

export interface OfficeHistoryPage extends Omit<HermesHistoryDto, "pagination"> {
  pagination: {
    limit: number;
    offset: number;
    returned: number;
    hasMore: boolean;
    nextCursor?: string;
    pageLimitedByBytes: boolean;
  };
}

export class HistoryHttpInputError extends Error {}

/** Fetches a bounded history page and exposes an opaque continuation cursor. */
export async function fetchOfficeHistoryPage(
  chat: HermesChatTransport,
  requestUrl: URL,
  sessionId: string,
  maxResponseBytes: number,
): Promise<OfficeHistoryPage> {
  validateQuery(requestUrl);
  const profile = requestUrl.searchParams.get("profile") ?? "default";
  const limit = parseLimit(requestUrl.searchParams.get("limit"));
  const offset = decodeCursor(requestUrl.searchParams.get("cursor"));
  const history = await chat.fetchHistory({ sessionId, profile, limit, offset });
  return fitPage(history, limit, offset, maxResponseBytes);
}

function fitPage(
  history: HermesHistoryDto,
  limit: number,
  offset: number,
  maxResponseBytes: number,
): OfficeHistoryPage {
  const messages: HermesHistoryDto["messages"] = [];
  for (const message of history.messages) {
    const candidate = makePage(history, messages.concat(message), limit, offset, true, false);
    if (Buffer.byteLength(JSON.stringify(candidate)) > maxResponseBytes) break;
    messages.push(message);
  }

  const pageLimitedByBytes = messages.length < history.messages.length;
  const upstreamMayHaveMore = history.pagination.returned >= limit;
  const hasMore = pageLimitedByBytes || upstreamMayHaveMore;
  if (hasMore && messages.length === 0) {
    throw new Error("A single history message exceeds the Office response budget.");
  }
  const page = makePage(history, messages, limit, offset, hasMore, pageLimitedByBytes);
  if (Buffer.byteLength(JSON.stringify(page)) > maxResponseBytes) {
    throw new Error("History metadata exceeds the Office response budget.");
  }
  return page;
}

function makePage(
  history: HermesHistoryDto,
  messages: HermesHistoryDto["messages"],
  limit: number,
  offset: number,
  hasMore: boolean,
  pageLimitedByBytes: boolean,
): OfficeHistoryPage {
  const nextOffset = messages.length === 0
    ? offset
    : Math.max(offset + messages.length, messages[messages.length - 1]!.index + 1);
  return {
    sessionId: history.sessionId,
    profile: history.profile,
    messages,
    pagination: {
      limit,
      offset,
      returned: messages.length,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursor(nextOffset) } : {}),
      pageLimitedByBytes,
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
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
    throw new HistoryHttpInputError(`History limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  return parsed;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`v1:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(value: string | null): number {
  if (value === null) return 0;
  let decoded: string;
  try { decoded = Buffer.from(value, "base64url").toString("utf8"); }
  catch { throw new HistoryHttpInputError("History cursor is invalid."); }
  if (!/^v1:(?:0|[1-9][0-9]{0,6})$/.test(decoded)) throw new HistoryHttpInputError("History cursor is invalid.");
  const offset = Number(decoded.slice(3));
  if (!Number.isSafeInteger(offset) || offset > 1_000_000) throw new HistoryHttpInputError("History cursor is invalid.");
  return offset;
}
