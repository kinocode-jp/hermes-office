import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHistoryPage } from "../src/chat-api";

test("history page metadata and stable cross-page message indexes are normalized", () => {
  const page = normalizeHistoryPage({
    sessionId: "stored-resolved",
    messages: [
      { index: 25, role: "user", text: "next user message" },
      { index: 26, role: "assistant", text: "next assistant message" },
    ],
    pagination: { hasMore: true, nextCursor: "djE6Mjc", returned: 2 },
  }, "stored-requested");

  assert.equal(page.resolvedStoredSessionId, "stored-resolved");
  assert.deepEqual(page.messages.map((message) => message.id), [
    "history-stored-requested-25",
    "history-stored-requested-26",
  ]);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, "djE6Mjc");
});

test("a continuation flag without a cursor is rejected", () => {
  assert.throws(
    () => normalizeHistoryPage({ messages: [], pagination: { hasMore: true } }, "stored-1"),
    /履歴ページ情報/,
  );
});
