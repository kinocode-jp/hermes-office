import assert from "node:assert/strict";
import test from "node:test";
import { HistoryAccumulator } from "../src/history-loader.ts";

test("normal history pages accumulate completely", () => {
  const history = new HistoryAccumulator({ maxPages: 4, maxMessages: 10, maxBytes: 10_000 });
  assert.equal(history.append(page([message(0), message(1)], true)), true);
  assert.equal(history.append(page([message(2)], false)), false);
  assert.deepEqual(history.messages.map((item) => item.id), ["m0", "m1", "m2"]);
  assert.deepEqual(history.result(), { truncated: false, partial: false, loadedPages: 2, loadedMessages: 3, loadedBytes: history.result().loadedBytes });
});

test("message, UTF-8 byte, and page boundaries stop accumulation without an error", () => {
  const byMessage = new HistoryAccumulator({ maxPages: 10, maxMessages: 3, maxBytes: 10_000 });
  byMessage.append(page([message(0), message(1)], true));
  assert.equal(byMessage.append(page([message(2), message(3)], true)), false);
  assert.deepEqual({ count: byMessage.messages.length, reason: byMessage.result().reason, partial: byMessage.result().partial }, { count: 3, reason: "message_limit", partial: true });

  const byByte = new HistoryAccumulator({ maxPages: 10, maxMessages: 10, maxBytes: 250 });
  assert.equal(byByte.append(page([message(0, "あ".repeat(60)), message(1, "b".repeat(60))], true)), false);
  assert.equal(byByte.result().reason, "byte_limit");
  assert.ok(byByte.result().loadedBytes <= 250);

  const byPage = new HistoryAccumulator({ maxPages: 2, maxMessages: 10, maxBytes: 10_000 });
  assert.equal(byPage.append(page([message(0)], true)), true);
  assert.equal(byPage.append(page([message(1)], true)), false);
  assert.equal(byPage.result().reason, "page_limit");
});

test("a 50,000-message shaped source stops after 500 messages instead of 2,000 pages", () => {
  const history = new HistoryAccumulator();
  let fetchedPages = 0;
  for (let pageNumber = 0; pageNumber < 2_000; pageNumber += 1) {
    fetchedPages += 1;
    const start = pageNumber * 25;
    if (!history.append(page(Array.from({ length: 25 }, (_, index) => message(start + index)), true))) break;
  }
  assert.equal(fetchedPages, 20);
  assert.equal(history.messages.length, 500);
  assert.deepEqual({ truncated: history.result().truncated, partial: history.result().partial, reason: history.result().reason }, { truncated: true, partial: true, reason: "message_limit" });
});

test("a later upstream failure preserves already loaded history as partial", () => {
  const history = new HistoryAccumulator();
  history.append(page([message(0), message(1)], true));
  history.fail("temporary history failure");
  assert.deepEqual({ count: history.messages.length, partial: history.result().partial, reason: history.result().reason, error: history.result().error }, { count: 2, partial: true, reason: "upstream_error", error: "temporary history failure" });
});

function page(messages: ReturnType<typeof message>[], hasMore: boolean) {
  return { messages, hasMore, truncated: false, partial: false };
}

function message(index: number, body = `message-${index}`) {
  return { id: `m${index}`, from: "agent" as const, body, at: "12:00", status: "complete" as const };
}
