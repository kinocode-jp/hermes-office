import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, ChatSession } from "../src/domain.ts";
import { DEFAULT_CLIENT_HISTORY_LIMITS } from "../src/history-loader.ts";
import {
  appendLiveDelta,
  appendLiveMessage,
  chatMessageBytes,
  chatTranscriptBytes,
  boundedTranscriptSuffix,
  LIVE_TRANSCRIPT_LIMITS,
} from "../src/live-transcript.ts";
import { applyChatGatewayEvent, applyChatHistory, reduceChatGatewayEvent, sessions, setChatHistoryLoading, setChatSessionReady } from "../src/store.ts";

test("live transcript uses the saved-history row and serialized UTF-8 limits", () => {
  assert.equal(LIVE_TRANSCRIPT_LIMITS.maxRows, DEFAULT_CLIENT_HISTORY_LIMITS.maxMessages);
  assert.equal(LIVE_TRANSCRIPT_LIMITS.maxBytes, DEFAULT_CLIENT_HISTORY_LIMITS.maxBytes);

  const rows = Array.from({ length: LIVE_TRANSCRIPT_LIMITS.maxRows }, (_, index) => message(`m-${index}`, "x"));
  const atBoundary = appendLiveMessage(rows.slice(0, -1), rows.at(-1)!);
  assert.equal(atBoundary.status, "accepted");
  if (atBoundary.status !== "accepted") return;
  assert.equal(atBoundary.messages.length, LIVE_TRANSCRIPT_LIMITS.maxRows);
  const advanced = appendLiveMessage(atBoundary.messages, message("overflow", "x"));
  assert.equal(advanced.status, "accepted");
  if (advanced.status !== "accepted") return;
  assert.equal(advanced.windowed, true);
  assert.equal(advanced.messages.length, LIVE_TRANSCRIPT_LIMITS.maxRows);
  assert.equal(advanced.messages[0]?.id, "m-1");
  assert.equal(advanced.messages.at(-1)?.id, "overflow");

  const alreadyOver = [...atBoundary.messages, message("legacy-overflow", "x")];
  assert.deepEqual(appendLiveDelta(alreadyOver, "m-499", "delta"), {
    status: "resync-required",
    reason: "row_limit",
  });
  assert.equal(alreadyOver.at(-2)?.body, "x", "an already-invalid transcript is never mutated or normalized silently");
});

test("history/live seam keeps a visible bounded newest suffix", () => {
  const rows = Array.from({ length: LIVE_TRANSCRIPT_LIMITS.maxRows + 1 }, (_, index) => message(`m-${index}`, "x"));
  const bounded = boundedTranscriptSuffix(rows);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.messages.length, LIVE_TRANSCRIPT_LIMITS.maxRows);
  assert.equal(bounded.messages[0]?.id, "m-1");
  assert.equal(bounded.messages.at(-1)?.id, `m-${LIVE_TRANSCRIPT_LIMITS.maxRows}`);
});

test("serialized UTF-8 byte boundary is inclusive and one byte over requires resync", () => {
  const empty = message("one", "");
  const overhead = chatMessageBytes(empty);
  const exact = message("one", "a".repeat(LIVE_TRANSCRIPT_LIMITS.maxBytes - overhead));
  assert.equal(chatMessageBytes(exact), LIVE_TRANSCRIPT_LIMITS.maxBytes);
  const accepted = appendLiveMessage([], exact);
  assert.equal(accepted.status, "accepted");
  if (accepted.status === "accepted") assert.equal(chatTranscriptBytes(accepted.messages), LIVE_TRANSCRIPT_LIMITS.maxBytes);
  const advanced = appendLiveMessage([exact], message("newest", "", "streaming"));
  assert.equal(advanced.status, "accepted");
  if (advanced.status === "accepted") {
    assert.equal(advanced.windowed, true);
    assert.deepEqual(advanced.messages.map(({ id }) => id), ["newest"]);
  }
  assert.deepEqual(appendLiveMessage([], { ...exact, body: `${exact.body}a` }), {
    status: "resync-required",
    reason: "byte_limit",
  });
});

test("streaming delta boundary is checked before concatenation and preserves the accepted row on overflow", () => {
  const initial = message("stream", "a".repeat(LIVE_TRANSCRIPT_LIMITS.maxStreamingMessageBytes - 1), "streaming");
  const started = appendLiveMessage([], initial);
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") return;

  const boundary = appendLiveDelta(started.messages, "stream", "b");
  assert.equal(boundary.status, "accepted");
  if (boundary.status !== "accepted") return;
  assert.equal(boundary.messages[0]?.body.length, LIVE_TRANSCRIPT_LIMITS.maxStreamingMessageBytes);
  assert.deepEqual(appendLiveDelta(boundary.messages, "stream", "c"), {
    status: "resync-required",
    reason: "streaming_message_limit",
  });
  assert.equal(boundary.messages[0]?.body.endsWith("c"), false);
});

test("a delta crossing the total byte boundary advances the newest window", () => {
  const stream = message("stream", "a", "streaming");
  const oldEmpty = message("old", "");
  const old = message("old", "x".repeat(
    LIVE_TRANSCRIPT_LIMITS.maxBytes - chatMessageBytes(stream) - chatMessageBytes(oldEmpty),
  ));
  const exact = [old, stream];
  assert.equal(chatTranscriptBytes(exact), LIVE_TRANSCRIPT_LIMITS.maxBytes);
  const advanced = appendLiveDelta(exact, "stream", "b");
  assert.equal(advanced.status, "accepted");
  if (advanced.status !== "accepted") return;
  assert.equal(advanced.windowed, true);
  assert.deepEqual(advanced.messages.map(({ id }) => id), ["stream"]);
  assert.equal(advanced.messages[0]?.body, "ab");
});

test("incremental JSON accounting remains exact across escapes and split surrogate pairs", () => {
  const first = appendLiveMessage([], message("stream", "prefix\ud83d", "streaming"));
  assert.equal(first.status, "accepted");
  if (first.status !== "accepted") return;
  const second = appendLiveDelta(first.messages, "stream", "\ude00\n\\\"");
  assert.equal(second.status, "accepted");
  if (second.status !== "accepted") return;
  assert.equal(chatTranscriptBytes(second.messages), chatMessageBytes(second.messages[0]!));
  assert.equal(second.messages[0]?.body, "prefix😀\n\\\"");
});

test("message, tool, delta, and complete advance a full live window without a barrier", () => {
  const full = session("bounded", Array.from({ length: LIVE_TRANSCRIPT_LIMITS.maxRows }, (_, index) => message(`m-${index}`, "x")));
  let barrierReason = "";
  const started = reduceChatGatewayEvent(full, {
    type: "message.start",
    liveSessionId: "live-bounded",
    payload: { messageId: "stream-new" },
  }, (reason) => { barrierReason = reason; });
  assert.equal(barrierReason, "");
  assert.equal(started.messages.length, LIVE_TRANSCRIPT_LIMITS.maxRows);
  assert.equal(started.messages[0]?.id, "m-1");
  assert.equal(started.messages.at(-1)?.id, "stream-new");
  assert.equal(started.historyPartial, true);

  const delta = reduceChatGatewayEvent(started, {
    type: "message.delta",
    liveSessionId: "live-bounded",
    payload: { messageId: "stream-new", text: "hello" },
  }, (reason) => { barrierReason = reason; });
  assert.equal(delta.messages.at(-1)?.body, "hello");

  const afterTool = reduceChatGatewayEvent(delta, {
    type: "tool.start",
    liveSessionId: "live-bounded",
    payload: { toolId: "tool-new", name: "Shell" },
  }, (reason) => { barrierReason = reason; });
  assert.equal(barrierReason, "");
  assert.equal(afterTool.messages.length, LIVE_TRANSCRIPT_LIMITS.maxRows);
  assert.equal(afterTool.messages.at(-1)?.id, "tool-new");

  const toolComplete = reduceChatGatewayEvent(afterTool, {
    type: "tool.complete",
    liveSessionId: "live-bounded",
    payload: { toolId: "tool-new", name: "Shell", summary: "done" },
  });
  assert.equal(toolComplete.messages.at(-1)?.status, "complete");

  const completed = reduceChatGatewayEvent(toolComplete, {
    type: "message.complete",
    liveSessionId: "live-bounded",
    payload: { messageId: "stream-new", text: "hello complete" },
  });
  assert.equal(completed.messages.find(({ id }) => id === "stream-new")?.body, "hello complete");
  assert.equal(completed.messages.length, LIVE_TRANSCRIPT_LIMITS.maxRows);
});

test("an oversized single streaming message still enters the history barrier", () => {
  const streaming = session("large-complete", [message("stream", "ok", "streaming")]);
  let bodyReason = "";
  const afterComplete = reduceChatGatewayEvent(streaming, {
    type: "message.complete",
    liveSessionId: "live-large-complete",
    payload: { messageId: "stream", text: "a".repeat(LIVE_TRANSCRIPT_LIMITS.maxStreamingMessageBytes + 1) },
  }, (reason) => { bodyReason = reason; });
  assert.equal(afterComplete, streaming);
  assert.equal(bodyReason, "streaming_message_limit");
});

test("four open panes keep independent bounded transcripts", () => {
  const previous = sessions.value;
  sessions.value = Array.from({ length: 4 }, (_, pane) => session(
    `pane-${pane}`,
    Array.from({ length: LIVE_TRANSCRIPT_LIMITS.maxRows - 1 }, (_, row) => message(`p${pane}-m${row}`, "x")),
  ));
  try {
    for (let pane = 0; pane < 4; pane += 1) {
      const result = applyChatGatewayEvent(`pane-${pane}`, {
        type: "tool.start",
        liveSessionId: `live-pane-${pane}`,
        payload: { toolId: `tool-${pane}`, summary: "running" },
      });
      assert.equal(result, undefined);
    }
    assert.deepEqual(sessions.value.map(({ messages }) => messages.length), [500, 500, 500, 500]);

    const advanced = applyChatGatewayEvent("pane-0", {
      type: "tool.start",
      liveSessionId: "live-pane-0",
      payload: { toolId: "second-tool", summary: "running" },
    });
    assert.equal(advanced, undefined);
    assert.deepEqual(sessions.value.map(({ messages }) => messages.length), [500, 500, 500, 500]);
    assert.deepEqual(sessions.value.map(({ historyPartial }) => historyPartial === true), [true, false, false, false]);
    assert.equal(sessions.value[0]?.messages.at(-1)?.id, "second-tool");
    assert.equal(sessions.value[1]?.messages.at(-1)?.id, "tool-1");
  } finally {
    sessions.value = previous;
  }
});

test("a barrier reload at the saved-history cap can resume and advance its live window", () => {
  const previous = sessions.value;
  const history = Array.from({ length: LIVE_TRANSCRIPT_LIMITS.maxRows }, (_, index) => message(`saved-${index}`, "x"));
  sessions.value = [session("recover", history)];
  try {
    assert.equal(applyChatGatewayEvent("recover", {
      type: "message.start", liveSessionId: "live-recover", payload: { messageId: "stream" },
    }), undefined);
    assert.equal(sessions.value[0]?.historyPartial, true);
    assert.equal(applyChatGatewayEvent("recover", {
      type: "message.delta", liveSessionId: "live-recover",
      payload: { messageId: "stream", text: "x".repeat(LIVE_TRANSCRIPT_LIMITS.maxStreamingMessageBytes + 1) },
    }), "resync-required");

    setChatHistoryLoading("recover", true);
    applyChatHistory("recover", history, "stored-recover", {
      truncated: false, partial: false, loadedPages: 20, loadedMessages: 500, loadedBytes: chatTranscriptBytes(history),
    });
    setChatSessionReady("recover", "live-recovered", "stored-recover", { running: false });
    assert.equal(applyChatGatewayEvent("recover", {
      type: "tool.start", liveSessionId: "live-recovered", payload: { toolId: "after-recovery", summary: "running" },
    }), undefined);
    assert.equal(sessions.value[0]?.messages.length, LIVE_TRANSCRIPT_LIMITS.maxRows);
    assert.equal(sessions.value[0]?.messages.at(-1)?.id, "after-recovery");
    assert.equal(sessions.value[0]?.historyPartial, true);
  } finally {
    sessions.value = previous;
  }
});

function message(id: string, body: string, status: ChatMessage["status"] = "complete"): ChatMessage {
  return { id, from: "agent", body, at: "00:00", status };
}

function session(id: string, messages: ChatMessage[]): ChatSession {
  return {
    id,
    profileId: id,
    title: id,
    status: messages.some(({ status }) => status === "streaming") ? "streaming" : "ready",
    messages,
    liveSessionId: `live-${id}`,
    connectionState: "ready",
    historyState: "loaded",
    remoteKind: "stored",
  };
}
