import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import { applyChatGatewayEvent, reduceChatGatewayEvent, registerChatRuntime, respondToApproval, sessions } from "../src/store.ts";

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
    payload: { approvalId: "approval-one", command: "rm temp.txt", choices: ["once", "always", "deny"], allowPermanent: false }
  });

  assert.equal(next.pendingInteraction?.kind, "approval");
  assert.deepEqual(next.pendingInteraction?.choices, ["once", "deny"]);
});

test("an older approval completion cannot clear a newly promoted approval", async () => {
  let resolve!: () => void;
  const submitted: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
    async respondClarify() {},
    respondApproval: async (_sessionId, approvalId) => {
      submitted.push(approvalId);
      await new Promise<void>((done) => { resolve = done; });
    },
  });
  sessions.value = [reduceChatGatewayEvent(session, {
    type: "approval.request", liveSessionId: "live-1",
    payload: { approvalId: "approval-A", choices: ["once"], allowPermanent: false },
  })];
  const submission = respondToApproval(session.id, "once");
  applyChatGatewayEvent(session.id, {
    type: "approval.request", liveSessionId: "live-1",
    payload: { approvalId: "approval-B", choices: ["deny"], allowPermanent: false },
  });
  resolve();
  await submission;
  assert.deepEqual(submitted, ["approval-A"]);
  assert.equal(sessions.value[0]!.pendingInteraction?.id, "approval:approval-B");
  const submissionB = respondToApproval(session.id, "deny");
  applyChatGatewayEvent(session.id, {
    type: "approval.request", liveSessionId: "live-1",
    payload: { approvalId: "approval-C", choices: ["once"], allowPermanent: false },
  });
  resolve();
  await submissionB;
  assert.deepEqual(submitted, ["approval-A", "approval-B"]);
  assert.equal(sessions.value[0]!.pendingInteraction?.id, "approval:approval-C");
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
