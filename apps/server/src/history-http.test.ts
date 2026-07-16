import assert from "node:assert/strict";
import test from "node:test";
import type { HermesChatTransport, HermesHistoryMessageDto } from "./hermes-chat.js";
import { fetchOfficeHistoryPage, HistoryHttpInputError } from "./history-http.js";

test("history pages stay within their response budget and continue without losing messages", async () => {
  const source = Array.from({ length: 6 }, (_, index): HermesHistoryMessageDto => ({
    index,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message-${index}-${"\u0001".repeat(150_000)}`,
  }));
  const requests: Array<{ limit?: number; offset?: number }> = [];
  const chat = {
    connect: async () => { throw new Error("unused"); },
    fetchHistory: async (request) => {
      requests.push({
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.offset === undefined ? {} : { offset: request.offset }),
      });
      const limit = request.limit ?? 25;
      const offset = request.offset ?? 0;
      const messages = source.slice(offset, offset + limit);
      return {
        sessionId: request.sessionId,
        profile: request.profile,
        messages,
        pagination: { limit, offset, returned: messages.length },
      };
    },
  } satisfies HermesChatTransport;

  const firstUrl = new URL("http://office.local/messages?profile=default&limit=6");
  const first = await fetchOfficeHistoryPage(chat, firstUrl, "stored-1", 1024 * 1024);
  assert.equal(first.pagination.pageLimitedByBytes, true);
  assert.equal(first.pagination.hasMore, true);
  assert.ok(first.pagination.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024);

  const secondUrl = new URL(`http://office.local/messages?profile=default&limit=6&cursor=${first.pagination.nextCursor!}`);
  const second = await fetchOfficeHistoryPage(chat, secondUrl, "stored-1", 1024 * 1024);
  assert.equal(second.messages[0]?.index, first.messages.length);
  assert.deepEqual(requests, [{ limit: 6, offset: 0 }, { limit: 6, offset: first.messages.length }]);
});

test("history query rejects unbounded limits and forged cursors", async () => {
  const chat = { connect: async () => { throw new Error("unused"); }, fetchHistory: async () => { throw new Error("must not run"); } } as unknown as HermesChatTransport;
  await assert.rejects(
    fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?limit=500"), "stored-1", 1024 * 1024),
    HistoryHttpInputError,
  );
  await assert.rejects(
    fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?cursor=forged"), "stored-1", 1024 * 1024),
    HistoryHttpInputError,
  );
});
