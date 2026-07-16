import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import { reduceChatGatewayEvent } from "../src/store.ts";

const session: ChatSession = {
  id: "client-1",
  profileId: "builder",
  title: "Build",
  status: "streaming",
  messages: [],
  connectionState: "ready",
  remoteKind: "stored"
};

test("clarification requests become durable waiting interactions", () => {
  const next = reduceChatGatewayEvent(session, {
    type: "clarify.request",
    liveSessionId: "live-1",
    payload: { requestId: "request-1", question: "対象はどれですか？", choices: ["A", "B"] }
  });

  assert.equal(next.status, "waiting");
  assert.deepEqual(next.pendingInteraction, {
    id: "clarify:request-1",
    kind: "clarify",
    requestId: "request-1",
    question: "対象はどれですか？",
    choices: ["A", "B"],
    submitting: false
  });
});

test("permanent approval is removed unless the gateway explicitly permits it", () => {
  const next = reduceChatGatewayEvent(session, {
    type: "approval.request",
    liveSessionId: "live-1",
    payload: { command: "rm temp.txt", choices: ["once", "always", "deny"], allowPermanent: false }
  });

  assert.equal(next.pendingInteraction?.kind, "approval");
  assert.deepEqual(next.pendingInteraction?.choices, ["once", "deny"]);
});

test("duplicate events retain submit lock and completion clears the interaction", () => {
  const waiting: ChatSession = {
    ...session,
    status: "waiting",
    pendingInteraction: {
      id: "clarify:request-1",
      kind: "clarify",
      requestId: "request-1",
      question: "古い質問",
      choices: [],
      submitting: true
    }
  };
  const duplicate = reduceChatGatewayEvent(waiting, {
    type: "clarify.request",
    liveSessionId: "live-1",
    payload: { requestId: "request-1", question: "更新された質問", choices: [] }
  });
  assert.equal(duplicate.pendingInteraction?.submitting, true);

  const complete = reduceChatGatewayEvent(duplicate, {
    type: "message.complete",
    liveSessionId: "live-1",
    payload: { messageId: "message-1", text: "完了" }
  });
  assert.equal(complete.pendingInteraction, undefined);
});

test("private sudo and secret events are never promoted to public interactions", () => {
  assert.equal(reduceChatGatewayEvent(session, { type: "sudo.request", liveSessionId: "live-1" }), session);
  assert.equal(reduceChatGatewayEvent(session, { type: "secret.request", liveSessionId: "live-1" }), session);
});
