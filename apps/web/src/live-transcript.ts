import type { ChatMessage } from "./domain";
import { CHAT_TRANSCRIPT_LIMITS } from "./chat-transcript-limits";

export const LIVE_TRANSCRIPT_LIMITS = {
  maxRows: CHAT_TRANSCRIPT_LIMITS.maxRows,
  maxBytes: CHAT_TRANSCRIPT_LIMITS.maxBytes,
  maxStreamingMessageBytes: CHAT_TRANSCRIPT_LIMITS.maxStreamingMessageBytes,
} as const;

export type TranscriptChange =
  | { status: "accepted"; messages: ChatMessage[] }
  | { status: "resync-required"; reason: "row_limit" | "byte_limit" | "streaming_message_limit" };

const encoder = new TextEncoder();
const messageBytes = new WeakMap<ChatMessage, number>();
const bodyBytes = new WeakMap<ChatMessage, number>();
const transcriptBytes = new WeakMap<ChatMessage[], number>();

/** Uses the same serialized-row accounting as saved-history pagination. */
export function chatMessageBytes(message: ChatMessage): number {
  const cached = messageBytes.get(message);
  if (cached !== undefined) return cached;
  const measured = encoder.encode(JSON.stringify(message)).byteLength + 1;
  messageBytes.set(message, measured);
  return measured;
}

export function chatTranscriptBytes(messages: ChatMessage[]): number {
  const cached = transcriptBytes.get(messages);
  if (cached !== undefined) return cached;
  const measured = messages.reduce((total, message) => total + chatMessageBytes(message), 0);
  transcriptBytes.set(messages, measured);
  return measured;
}

export function appendLiveMessage(messages: ChatMessage[], message: ChatMessage): TranscriptChange {
  if (messages.length >= LIVE_TRANSCRIPT_LIMITS.maxRows) return resync("row_limit");
  if (isStreaming(message) && utf8BodyBytes(message) > LIVE_TRANSCRIPT_LIMITS.maxStreamingMessageBytes) {
    return resync("streaming_message_limit");
  }
  const nextBytes = chatTranscriptBytes(messages) + chatMessageBytes(message);
  if (nextBytes > LIVE_TRANSCRIPT_LIMITS.maxBytes) return resync("byte_limit");
  const next = [...messages, message];
  transcriptBytes.set(next, nextBytes);
  return { status: "accepted", messages: next };
}

export function appendLiveDelta(messages: ChatMessage[], messageId: string, delta: string): TranscriptChange {
  if (messages.length > LIVE_TRANSCRIPT_LIMITS.maxRows) return resync("row_limit");
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) {
    return appendLiveMessage(messages, {
      id: messageId,
      from: "agent",
      body: delta,
      at: "",
      status: "streaming",
    });
  }
  const current = messages[index]!;
  const nextBodyBytes = utf8BodyBytes(current) + appendedUtf8Bytes(current.body, delta);
  if (nextBodyBytes > LIVE_TRANSCRIPT_LIMITS.maxStreamingMessageBytes) return resync("streaming_message_limit");

  // The normal delta path changes only `body`. Account for its JSON-escaped
  // suffix before concatenating, so an oversized delta never creates a second
  // giant string. Unexpected non-streaming rows use the generic safe path.
  if (current.status !== "streaming") {
    return replaceLiveMessage(messages, index, { ...current, body: current.body + delta, status: "streaming" }, true);
  }
  const nextBytes = chatTranscriptBytes(messages) + appendedJsonStringBytes(current.body, delta);
  if (nextBytes > LIVE_TRANSCRIPT_LIMITS.maxBytes) return resync("byte_limit");
  const replacement = { ...current, body: current.body + delta, status: "streaming" as const };
  bodyBytes.set(replacement, nextBodyBytes);
  messageBytes.set(replacement, chatMessageBytes(current) + appendedJsonStringBytes(current.body, delta));
  const next = messages.map((message, currentIndex) => currentIndex === index ? replacement : message);
  transcriptBytes.set(next, nextBytes);
  return { status: "accepted", messages: next };
}

export function replaceLiveMessage(
  messages: ChatMessage[],
  index: number,
  replacement: ChatMessage,
  enforceStreamingLimit = isStreaming(replacement),
): TranscriptChange {
  if (messages.length > LIVE_TRANSCRIPT_LIMITS.maxRows) return resync("row_limit");
  const current = messages[index];
  if (!current) return appendLiveMessage(messages, replacement);
  if (enforceStreamingLimit && utf8BodyBytes(replacement) > LIVE_TRANSCRIPT_LIMITS.maxStreamingMessageBytes) {
    return resync("streaming_message_limit");
  }
  const nextBytes = chatTranscriptBytes(messages) - chatMessageBytes(current) + chatMessageBytes(replacement);
  if (nextBytes > LIVE_TRANSCRIPT_LIMITS.maxBytes) return resync("byte_limit");
  const next = messages.map((message, currentIndex) => currentIndex === index ? replacement : message);
  transcriptBytes.set(next, nextBytes);
  return { status: "accepted", messages: next };
}

export function replaceLiveMessages(
  messages: ChatMessage[],
  replacements: ChatMessage[],
  enforceBodyLimitFor: ReadonlySet<string> = new Set(),
): TranscriptChange {
  if (replacements.length > LIVE_TRANSCRIPT_LIMITS.maxRows) return resync("row_limit");
  if (replacements.some((message) => (isStreaming(message) || enforceBodyLimitFor.has(message.id))
    && utf8BodyBytes(message) > LIVE_TRANSCRIPT_LIMITS.maxStreamingMessageBytes)) {
    return resync("streaming_message_limit");
  }
  const nextBytes = chatTranscriptBytes(replacements);
  if (nextBytes > LIVE_TRANSCRIPT_LIMITS.maxBytes) return resync("byte_limit");
  return { status: "accepted", messages: replacements };
}

/** Keeps one contiguous newest window and reports the omission to the caller. */
export function boundedTranscriptSuffix(messages: ChatMessage[]): { messages: ChatMessage[]; truncated: boolean } {
  if (messages.length <= LIVE_TRANSCRIPT_LIMITS.maxRows
    && chatTranscriptBytes(messages) <= LIVE_TRANSCRIPT_LIMITS.maxBytes) {
    return { messages, truncated: false };
  }
  const newestFirst: ChatMessage[] = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const nextBytes = bytes + chatMessageBytes(message);
    if (newestFirst.length >= LIVE_TRANSCRIPT_LIMITS.maxRows || nextBytes > LIVE_TRANSCRIPT_LIMITS.maxBytes) break;
    newestFirst.push(message);
    bytes = nextBytes;
  }
  const bounded = newestFirst.reverse();
  transcriptBytes.set(bounded, bytes);
  return { messages: bounded, truncated: true };
}

function utf8BodyBytes(message: ChatMessage): number {
  const cached = bodyBytes.get(message);
  if (cached !== undefined) return cached;
  const measured = encoder.encode(message.body).byteLength;
  bodyBytes.set(message, measured);
  return measured;
}

function appendedUtf8Bytes(current: string, suffix: string): number {
  const bytes = encoder.encode(suffix).byteLength;
  return joinsSurrogatePair(current, suffix) ? bytes - 2 : bytes;
}

function appendedJsonStringBytes(current: string, suffix: string): number {
  const bytes = jsonStringContentBytes(suffix);
  return joinsSurrogatePair(current, suffix) ? bytes - 8 : bytes;
}

function jsonStringContentBytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && isLowSurrogate(value.charCodeAt(index + 1))) { bytes += 4; index += 1; }
    else if (isHighSurrogate(code) || isLowSurrogate(code)) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

function joinsSurrogatePair(current: string, suffix: string): boolean {
  return current.length > 0 && suffix.length > 0
    && isHighSurrogate(current.charCodeAt(current.length - 1))
    && isLowSurrogate(suffix.charCodeAt(0));
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
function isStreaming(message: ChatMessage): boolean { return message.status === "streaming"; }
function resync(reason: Extract<TranscriptChange, { status: "resync-required" }>["reason"]): TranscriptChange {
  return { status: "resync-required", reason };
}
