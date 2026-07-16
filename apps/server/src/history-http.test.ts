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

test("normal multi-page history reaches its end with cumulative metadata", async () => {
  const chat = historyFixture(Array.from({ length: 3 }, (_, index) => shortMessage(index)));
  const limits = { maxPages: 10, maxMessages: 10, maxBytes: 1024 * 1024 };
  const first = await fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?limit=2"), "stored-1", 1024 * 1024, limits);
  const decoded = Buffer.from(first.pagination.nextCursor!, "base64url").toString("utf8");
  const tampered = Buffer.from(decoded.replace(/^v2:2:/, "v2:1:"), "utf8").toString("base64url");
  await assert.rejects(fetchOfficeHistoryPage(chat, new URL(`http://office.local/messages?limit=2&cursor=${tampered}`), "stored-1", 1024 * 1024, limits), HistoryHttpInputError);
  const second = await fetchOfficeHistoryPage(chat, new URL(`http://office.local/messages?limit=2&cursor=${first.pagination.nextCursor!}`), "stored-1", 1024 * 1024, limits);
  assert.equal(first.pagination.hasMore, true);
  assert.equal(second.pagination.hasMore, false);
  assert.equal(second.pagination.truncated, false);
  assert.deepEqual(second.pagination.cumulative, { pages: 2, messages: 3, bytes: first.pagination.cumulative.bytes + Buffer.byteLength(JSON.stringify(shortMessage(2))) + 1 });
});

test("cumulative message, byte, and page limits return safe partial pages", async () => {
  const messages = Array.from({ length: 6 }, (_, index) => shortMessage(index));
  const messageFirst = await fetchOfficeHistoryPage(historyFixture(messages), new URL("http://office.local/messages?limit=2"), "stored-1", 1024 * 1024, { maxPages: 10, maxMessages: 3, maxBytes: 1024 * 1024 });
  const messageLast = await fetchOfficeHistoryPage(historyFixture(messages), new URL(`http://office.local/messages?limit=2&cursor=${messageFirst.pagination.nextCursor!}`), "stored-1", 1024 * 1024, { maxPages: 10, maxMessages: 3, maxBytes: 1024 * 1024 });
  assert.deepEqual({ returned: messageLast.pagination.returned, truncated: messageLast.pagination.truncated, reason: messageLast.pagination.truncationReason, cumulative: messageLast.pagination.cumulative.messages }, { returned: 1, truncated: true, reason: "message_limit", cumulative: 3 });

  const large = [shortMessage(0, "x".repeat(700)), shortMessage(1, "y".repeat(700))];
  const byteLimited = await fetchOfficeHistoryPage(historyFixture(large), new URL("http://office.local/messages?limit=2"), "stored-1", 1024 * 1024, { maxPages: 10, maxMessages: 10, maxBytes: 1024 });
  assert.deepEqual({ returned: byteLimited.pagination.returned, truncated: byteLimited.pagination.truncated, reason: byteLimited.pagination.truncationReason }, { returned: 1, truncated: true, reason: "byte_limit" });

  const pageFirst = await fetchOfficeHistoryPage(historyFixture(messages), new URL("http://office.local/messages?limit=1"), "stored-1", 1024 * 1024, { maxPages: 2, maxMessages: 10, maxBytes: 1024 * 1024 });
  const pageLast = await fetchOfficeHistoryPage(historyFixture(messages), new URL(`http://office.local/messages?limit=1&cursor=${pageFirst.pagination.nextCursor!}`), "stored-1", 1024 * 1024, { maxPages: 2, maxMessages: 10, maxBytes: 1024 * 1024 });
  assert.deepEqual({ returned: pageLast.pagination.returned, truncated: pageLast.pagination.truncated, reason: pageLast.pagination.truncationReason, pages: pageLast.pagination.cumulative.pages }, { returned: 1, truncated: true, reason: "page_limit", pages: 2 });
});

function historyFixture(source: HermesHistoryMessageDto[]): HermesChatTransport {
  return {
    connect: async () => { throw new Error("unused"); },
    fetchHistory: async (request) => {
      const limit = request.limit ?? 25;
      const offset = request.offset ?? 0;
      const messages = source.slice(offset, offset + limit);
      return { sessionId: request.sessionId, profile: request.profile, messages, pagination: { limit, offset, returned: messages.length } };
    },
  };
}

function shortMessage(index: number, text = `message-${index}`): HermesHistoryMessageDto {
  return { index, role: index % 2 === 0 ? "user" : "assistant", text };
}
