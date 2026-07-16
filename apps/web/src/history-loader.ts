import type { ChatMessage } from "./domain";

export const DEFAULT_CLIENT_HISTORY_LIMITS: ClientHistoryLimits = {
  maxPages: 40,
  maxMessages: 500,
  maxBytes: 8 * 1024 * 1024,
};

export type HistoryLimitReason = "page_limit" | "message_limit" | "byte_limit" | "server_limit" | "upstream_error" | "upstream_invalid_rows";
export type ClientHistoryLimits = { maxPages: number; maxMessages: number; maxBytes: number };
export type BoundedHistoryPage = {
  messages: ChatMessage[];
  direction: "older" | "newer";
  hasMore: boolean;
  truncated: boolean;
  partial: boolean;
  truncationReason?: string;
};
export type ChatHistoryResult = {
  truncated: boolean;
  partial: boolean;
  loadedPages: number;
  loadedMessages: number;
  loadedBytes: number;
  reason?: HistoryLimitReason;
  error?: string;
};

const encoder = new TextEncoder();

export class HistoryAccumulator {
  readonly messages: ChatMessage[] = [];
  readonly #limits: ClientHistoryLimits;
  #pages = 0;
  #bytes = 0;
  #reason?: HistoryLimitReason;
  #error?: string;
  #serverPartial = false;

  constructor(limits: ClientHistoryLimits = DEFAULT_CLIENT_HISTORY_LIMITS) {
    if (!validLimits(limits)) throw new Error("Client history limits are invalid.");
    this.#limits = limits;
  }

  append(page: BoundedHistoryPage): boolean {
    this.#pages += 1;
    const accepted: ChatMessage[] = [];
    const candidates = page.direction === "older" ? [...page.messages].reverse() : page.messages;
    for (const message of candidates) {
      if (this.messages.length + accepted.length >= this.#limits.maxMessages) { this.#reason = "message_limit"; break; }
      const bytes = encoder.encode(JSON.stringify(message)).byteLength + 1;
      if (this.#bytes + bytes > this.#limits.maxBytes) { this.#reason = "byte_limit"; break; }
      if (page.direction === "older") accepted.unshift(message);
      else accepted.push(message);
      this.#bytes += bytes;
    }
    if (page.direction === "older") this.messages.unshift(...accepted);
    else this.messages.push(...accepted);
    this.#serverPartial ||= page.partial;
    if (page.truncated) {
      this.#reason ??= normalizeReason(page.truncationReason);
      if (this.#reason === "upstream_invalid_rows") this.#error ??= "Hermesの履歴に読み取れない項目があり、その項目を除外して表示しています。";
    }
    if (page.hasMore && this.#reason === undefined) {
      if (this.#pages >= this.#limits.maxPages) this.#reason = "page_limit";
      else if (this.messages.length >= this.#limits.maxMessages) this.#reason = "message_limit";
      else if (this.#bytes >= this.#limits.maxBytes) this.#reason = "byte_limit";
    }
    return page.hasMore && this.#reason === undefined;
  }

  fail(message: string): void {
    this.#reason = "upstream_error";
    this.#error = message;
  }

  result(): ChatHistoryResult {
    const truncated = this.#reason !== undefined;
    return {
      truncated,
      partial: this.#serverPartial || (truncated && this.messages.length > 0),
      loadedPages: this.#pages,
      loadedMessages: this.messages.length,
      loadedBytes: this.#bytes,
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
    };
  }
}

function normalizeReason(value: string | undefined): HistoryLimitReason {
  return value === "page_limit" || value === "message_limit" || value === "byte_limit" || value === "upstream_invalid_rows" ? value : "server_limit";
}

function validLimits(limits: ClientHistoryLimits): boolean {
  return Number.isSafeInteger(limits.maxPages) && limits.maxPages >= 1
    && Number.isSafeInteger(limits.maxMessages) && limits.maxMessages >= 1
    && Number.isSafeInteger(limits.maxBytes) && limits.maxBytes >= 1;
}
