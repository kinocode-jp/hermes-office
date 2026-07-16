import assert from "node:assert/strict";
import test from "node:test";
import type { HermesChatTransport, HermesHistoryMessageDto } from "./hermes-chat.js";
import { fetchOfficeHistoryPage, HistoryHttpInputError, type HistoryAggregateLimits, type OfficeHistoryPage } from "./history-http.js";

test("history pages prioritize newest messages while staying inside the response budget", async () => {
  const source = Array.from({ length: 6 }, (_, index): HermesHistoryMessageDto => ({
    index,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message-${index}-${"\u0001".repeat(150_000)}`,
  }));
  const requests: Array<{ limit?: number; offset?: number }> = [];
  const chat = historyFixture(source, requests);
  const first = await fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?profile=default&limit=6"), "stored-1", 1024 * 1024);
  assert.equal(first.pagination.direction, "older");
  assert.equal(first.pagination.pageLimitedByBytes, true);
  assert.equal(first.pagination.hasMore, true);
  assert.deepEqual(first.messages.map(({ index }) => index), [5]);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024);

  const second = await fetchOfficeHistoryPage(chat, historyUrl(first), "stored-1", 1024 * 1024);
  assert.deepEqual(second.messages.map(({ index }) => index), [4]);
  assert.deepEqual(requests, [{ limit: 6, offset: 0 }, { limit: 5, offset: 0 }]);
});

test("history query rejects unbounded limits, forged cursors, and cross-session cursor reuse", async () => {
  const chat = historyFixture([shortMessage(0), shortMessage(1)]);
  await assert.rejects(
    fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?limit=500"), "stored-1", 1024 * 1024),
    HistoryHttpInputError,
  );
  await assert.rejects(
    fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?cursor=forged"), "stored-1", 1024 * 1024),
    HistoryHttpInputError,
  );
  const first = await fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?limit=1"), "stored-1", 1024 * 1024);
  const cursor = first.pagination.nextCursor!;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(fetchOfficeHistoryPage(chat, new URL(`http://office.local/messages?limit=1&cursor=${tampered}`), "stored-1", 1024 * 1024), HistoryHttpInputError);
  await assert.rejects(fetchOfficeHistoryPage(chat, new URL(`http://office.local/messages?limit=1&cursor=${cursor}`), "other-session", 1024 * 1024), HistoryHttpInputError);
});

test("normal tail pages are returned newest-first by page and reconstruct insertion order", async () => {
  const result = await collectHistory(historyFixture(Array.from({ length: 3 }, (_, index) => shortMessage(index))), 2);
  assert.deepEqual(result.messages.map(({ index }) => index), [0, 1, 2]);
  assert.deepEqual(result.last.pagination.cumulative, {
    pages: 2,
    messages: 3,
    bytes: result.messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)) + 1, 0),
  });
  assert.equal(result.last.pagination.truncated, false);
  assert.equal(result.last.pagination.partial, false);
});

test("499, exactly 500, and more than 500 messages keep the latest bounded window accurately", async () => {
  for (const total of [499, 500, 501]) {
    const source = Array.from({ length: total }, (_, index) => shortMessage(index));
    const result = await collectHistory(historyFixture(source), 25);
    const expectedStart = Math.max(0, total - 500);
    assert.equal(result.messages.length, Math.min(total, 500));
    assert.equal(result.messages[0]?.index, total === 0 ? undefined : expectedStart);
    assert.equal(result.messages.at(-1)?.index, total - 1);
    assert.equal(result.last.pagination.truncated, total > 500);
    assert.equal(result.last.pagination.partial, total > 500);
    assert.equal(result.last.pagination.truncationReason, total > 500 ? "message_limit" : undefined);
    assert.deepEqual(result.last.pagination.window, { start: expectedStart, end: total, omittedBefore: total > 500 });
  }
});

test("message, UTF-8 byte, and page limits retain the newest safe suffix", async () => {
  const messages = Array.from({ length: 6 }, (_, index) => shortMessage(index));
  const messageLimits = { maxPages: 10, maxMessages: 3, maxBytes: 1024 * 1024 };
  const byMessage = await collectHistory(historyFixture(messages), 2, messageLimits);
  assert.deepEqual(byMessage.messages.map(({ index }) => index), [3, 4, 5]);
  assert.equal(byMessage.last.pagination.truncationReason, "message_limit");

  const large = [shortMessage(0, "x".repeat(700)), shortMessage(1, "y".repeat(700))];
  const byByte = await fetchOfficeHistoryPage(historyFixture(large), new URL("http://office.local/messages?limit=2"), "stored-1", 1024 * 1024, { maxPages: 10, maxMessages: 10, maxBytes: 1024 });
  assert.deepEqual(byByte.messages.map(({ index }) => index), [1]);
  assert.equal(byByte.pagination.truncationReason, "byte_limit");

  const byPage = await collectHistory(historyFixture(messages), 1, { maxPages: 2, maxMessages: 10, maxBytes: 1024 * 1024 });
  assert.deepEqual(byPage.messages.map(({ index }) => index), [4, 5]);
  assert.equal(byPage.last.pagination.truncationReason, "page_limit");
});

function historyFixture(source: HermesHistoryMessageDto[], requests: Array<{ limit?: number; offset?: number }> = []): HermesChatTransport {
  return {
    connect: async () => { throw new Error("unused"); },
    inspectHistory: async ({ sessionId }) => ({ sessionId, total: source.length }),
    fetchHistory: async (request) => {
      requests.push({ ...(request.limit === undefined ? {} : { limit: request.limit }), ...(request.offset === undefined ? {} : { offset: request.offset }) });
      const limit = request.limit ?? 25;
      const offset = request.offset ?? 0;
      const messages = source.slice(offset, offset + limit);
      return { sessionId: request.sessionId, profile: request.profile, messages, pagination: { limit, offset, returned: messages.length } };
    },
  };
}

async function collectHistory(chat: HermesChatTransport, limit: number, limits?: HistoryAggregateLimits) {
  const pages: OfficeHistoryPage[] = [];
  let url = new URL(`http://office.local/messages?limit=${limit}`);
  for (;;) {
    const page = await fetchOfficeHistoryPage(chat, url, "stored-1", 1024 * 1024, limits);
    pages.unshift(page);
    if (!page.pagination.hasMore) break;
    url = historyUrl(page, limit);
  }
  return { messages: pages.flatMap(({ messages }) => messages), last: pages[0]! };
}

function historyUrl(page: OfficeHistoryPage, limit = page.pagination.limit): URL {
  return new URL(`http://office.local/messages?limit=${limit}&cursor=${page.pagination.nextCursor!}`);
}

function shortMessage(index: number, text = `message-${index}`): HermesHistoryMessageDto {
  return { index, role: index % 2 === 0 ? "user" : "assistant", text };
}
