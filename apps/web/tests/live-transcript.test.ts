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
import { applyChatGatewayEvent, reduceChatGatewayEvent, sessions } from "../src/store.ts";

test("live transcript uses the saved-history row and serialized UTF-8 limits", () => {
  assert.equal(LIVE_TRANSCRIPT_LIMITS.maxRows, DEFAULT_CLIENT_HISTORY_LIMITS.maxMessages);
  assert.equal(LIVE_TRANSCRIPT_LIMITS.maxBytes, DEFAULT_CLIENT_HISTORY_LIMITS.maxBytes);

  const rows = Array.from({ length: LIVE_TRANSCRIPT_LIMITS.maxRows }, (_, index) => message(`m-${index}`, "x"));
  const atBoundary = appendLiveMessage(rows.slice(0, -1), rows.at(-1)!);
  assert.equal(atBoundary.status, "accepted");
  if (atBoundary.status !== "accepted") return;
  assert.equal(atBoundary.messages.length, LIVE_TRANSCRIPT_LIMITS.maxRows);
  assert.deepEqual(appendLiveMessage(atBoundary.messages, message("overflow", "x")), {
    status: "resync-required",
    reason: "row_limit",
  });

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

test("oversized tool additions and complete replacements converge on resync without changing the transcript", () => {
  const full = session("bounded", Array.from({ length: LIVE_TRANSCRIPT_LIMITS.maxRows }, (_, index) => message(`m-${index}`, "x")));
  let rowReason = "";
  const afterTool = reduceChatGatewayEvent(full, {
    type: "tool.start",
    liveSessionId: "live-bounded",
    payload: { toolId: "tool-overflow", name: "Shell" },
  }, (reason) => { rowReason = reason; });
  assert.equal(afterTool, full);
  assert.equal(rowReason, "row_limit");

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

    const overflow = applyChatGatewayEvent("pane-0", {
      type: "tool.start",
      liveSessionId: "live-pane-0",
      payload: { toolId: "second-tool", summary: "running" },
    });
    assert.equal(overflow, "resync-required");
    assert.deepEqual(sessions.value.map(({ messages }) => messages.length), [500, 500, 500, 500]);
    assert.equal(sessions.value[1]?.messages.at(-1)?.id, "tool-1");
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
