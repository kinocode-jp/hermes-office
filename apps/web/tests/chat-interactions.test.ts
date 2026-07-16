import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession, OfficeSnapshot } from "../src/domain.ts";
import { approvalChoicesForAccess } from "../src/components/chat-pane.tsx";
import { applyChatGatewayEvent, officeSnapshot, reduceChatGatewayEvent, registerChatRuntime, respondToApproval, sessions } from "../src/store.ts";

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
  assert.equal(next.pendingInteraction?.kind === "approval" && next.pendingInteraction.allowPermanent, false);
});

test("local owner capability preserves an explicitly allowed permanent approval", () => {
  officeSnapshot.value = snapshotWithOperations(["state.read", "chat.approval.permanent"]);
  try {
    const next = reduceChatGatewayEvent(session, {
      type: "approval.request", liveSessionId: "live-1",
      payload: { approvalId: "approval-owner", choices: ["once", "always"], allowPermanent: true },
    });
    assert.equal(next.pendingInteraction?.kind, "approval");
    assert.deepEqual(next.pendingInteraction?.choices, ["once", "always"]);
    assert.equal(next.pendingInteraction?.kind === "approval" && next.pendingInteraction.allowPermanent, true);
  } finally { officeSnapshot.value = undefined; }
});

test("approval UI hides permanent choice without current capability", () => {
  const interaction = {
    id: "approval:ui", kind: "approval" as const, approvalId: "ui", choices: ["once", "always", "deny"] as const,
    allowPermanent: true, submitting: false,
  };
  assert.deepEqual(approvalChoicesForAccess({ ...interaction, choices: [...interaction.choices] }, false), ["once", "deny"]);
  assert.deepEqual(approvalChoicesForAccess({ ...interaction, choices: [...interaction.choices] }, true), ["once", "always", "deny"]);
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

function snapshotWithOperations(allowedOperations: OfficeSnapshot["capabilities"]["access"]["allowedOperations"]): OfficeSnapshot {
  return {
    generatedAt: "2026-07-16T00:00:00.000Z", sequence: 1,
    capabilities: {
      protocolVersion: 1, serverVersion: "0.1.0", runtime: { state: "ready" }, features: ["chat"],
      access: { deviceId: "local-browser", tier: "owner", exposure: "loopback", authentication: "local-cookie", allowedOperations },
    },
    profiles: [], sessions: [], inventory: { profiles: emptyPage(), sessions: emptyPage() }, boards: [],
  };
}

function emptyPage() { return { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0 }; }
