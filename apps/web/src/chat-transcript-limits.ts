export const CHAT_TRANSCRIPT_LIMITS = {
  maxPages: 40,
  maxRows: 500,
  maxBytes: 8 * 1024 * 1024,
  maxStreamingMessageBytes: 1024 * 1024,
} as const;
