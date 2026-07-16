import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import { canSubmitChatPrompt, isChatRunActive, mergeGatewayStatusUpdate, mergeServerSessionStatus } from "../src/session-runtime.ts";
import { interruptSession, reduceChatGatewayEvent, registerChatRuntime, sendMessage, sessions } from "../src/store.ts";

const ready: ChatSession = {
  id: "client", storedSessionId: "stored", profileId: "profile", title: "Session",
  status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded"
};

test("server status merge advances fresh work but never regresses authoritative local work", () => {
  assert.equal(mergeServerSessionStatus(ready, "thinking"), "streaming");
  assert.equal(mergeServerSessionStatus({ ...ready, status: "streaming" }, "idle"), "streaming");
  assert.equal(mergeServerSessionStatus({ ...ready, status: "waiting" }, "using-tool"), "waiting");
  assert.equal(mergeServerSessionStatus({ ...ready, status: "ready", streamingMessageId: "live" }, "idle"), "streaming");
  assert.equal(mergeServerSessionStatus({ ...ready, connectionState: "error" }, "thinking"), "ready");
});

test("approval and clarification interactions remain waiting across stale inventory observations", () => {
  const approval: ChatSession = {
    ...ready, status: "waiting",
    pendingInteraction: { id: "approval:a", kind: "approval", approvalId: "a", choices: ["once"], allowPermanent: false, submitting: false }
  };
  const clarification: ChatSession = {
    ...ready, status: "waiting",
    pendingInteraction: { id: "clarify:c", kind: "clarify", requestId: "c", question: "Which?", choices: [], submitting: false }
  };
  assert.equal(mergeServerSessionStatus(approval, "idle"), "waiting");
  assert.equal(mergeServerSessionStatus(approval, "thinking"), "waiting");
  assert.equal(mergeServerSessionStatus(clarification, "idle"), "waiting");
  assert.equal(canSubmitChatPrompt(approval), false);
  assert.equal(canSubmitChatPrompt(clarification), false);
});

test("sendMessage rejects every in-flight shape and atomically blocks a second prompt", () => {
  const submitted: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, interrupt() {},
    submitPrompt(_sessionId, text) { submitted.push(text); },
    async respondClarify() {}, async respondApproval() {}
  });

  sessions.value = [{ ...ready }];
  sendMessage(ready.id, "first");
  sendMessage(ready.id, "second");
  assert.deepEqual(submitted, ["first"]);
  assert.equal(sessions.value[0]?.messages.filter((message) => message.from === "user").length, 1);

  sessions.value = [{ ...ready, streamingMessageId: "hidden-live" }];
  sendMessage(ready.id, "marker");
  sessions.value = [{ ...ready, messages: [{ id: "hidden", from: "agent", body: "", at: "00:00", status: "streaming" }] }];
  sendMessage(ready.id, "message");
  sessions.value = [{ ...ready, status: "waiting" }];
  sendMessage(ready.id, "waiting");
  assert.deepEqual(submitted, ["first"]);
});

test("canonical Hermes status notifications cannot create a run and preserve an active run", () => {
  const submitted: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, interrupt() {},
    submitPrompt(_sessionId, text) { submitted.push(text); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready }];
  sendMessage(ready.id, "first");
  const afterSubmitNotice = reduceChatGatewayEvent(sessions.value[0]!, {
    type: "status.update", liveSessionId: "live", payload: { kind: "process", message: "Preparing follow-up" }
  });
  assert.equal(afterSubmitNotice.status, "streaming");
  assert.equal(isChatRunActive(afterSubmitNotice), true);
  sessions.value = [afterSubmitNotice];
  sendMessage(ready.id, "duplicate-after-submit");

  const withoutKind = reduceChatGatewayEvent(ready, {
    type: "status.update", liveSessionId: "live", payload: { message: "Preparing follow-up" }
  });
  const beforeStart = reduceChatGatewayEvent(withoutKind, {
    type: "status.update", liveSessionId: "live", payload: { kind: "process", message: "Preparing follow-up" }
  });
  assert.equal(beforeStart, ready);
  assert.equal(isChatRunActive(beforeStart), false);
  sendMessage(ready.id, "duplicate-before-start");

  const started = reduceChatGatewayEvent(beforeStart, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "agent-1" }
  });
  const afterStart = reduceChatGatewayEvent(started, {
    type: "status.update", liveSessionId: "live", payload: { kind: "goal", text: "Goal progress" }
  });
  assert.equal(afterStart.status, "streaming");
  assert.equal(afterStart.streamingMessageId, "agent-1");
  assert.equal(isChatRunActive(afterStart), true);
  sessions.value = [afterStart];
  sendMessage(ready.id, "duplicate-after-start");
  assert.deepEqual(submitted, ["first"]);
});

test("only recognized status values transition and informational or unknown values preserve state", () => {
  assert.equal(mergeGatewayStatusUpdate(ready, { status: "thinking" }).status, "streaming");
  assert.equal(mergeGatewayStatusUpdate(ready, { kind: "using-tool" }).status, "streaming");
  assert.equal(mergeGatewayStatusUpdate(ready, { kind: "status", message: "waiting_for_user" }).status, "waiting");
  assert.equal(mergeGatewayStatusUpdate(ready, { kind: "status", message: "ready" }), ready);

  const active = { ...ready, status: "streaming" as const };
  assert.equal(mergeGatewayStatusUpdate(active, { kind: "status", text: "ready" }), active);
  assert.equal(mergeGatewayStatusUpdate(active, { kind: "compacting", text: "Compacting context" }), active);
  assert.equal(mergeGatewayStatusUpdate(active, { kind: "future-kind", text: "Ready-ish text" }), active);
  assert.equal(mergeGatewayStatusUpdate(active, {}), active);
  assert.equal(mergeGatewayStatusUpdate(active, { status: "future-status", kind: "status", text: "ready" }), active);
});

test("tool progress and approval waits remain active across status notifications", () => {
  const toolProgress = reduceChatGatewayEvent(ready, {
    type: "tool.progress", liveSessionId: "live", payload: { toolId: "tool-1", name: "Shell", summary: "Running" }
  });
  const afterToolNotice = reduceChatGatewayEvent(toolProgress, {
    type: "status.update", liveSessionId: "live", payload: { kind: "process", text: "Still working" }
  });
  assert.equal(isChatRunActive(afterToolNotice), true);
  assert.equal(afterToolNotice.messages[0]?.status, "streaming");

  const waiting = reduceChatGatewayEvent(ready, {
    type: "approval.request", liveSessionId: "live",
    payload: { approvalId: "approval-1", choices: ["once", "deny"], allowPermanent: false }
  });
  const afterWaitingNotice = reduceChatGatewayEvent(waiting, {
    type: "status.update", liveSessionId: "live", payload: { status: "thinking" }
  });
  assert.equal(afterWaitingNotice.status, "waiting");
  assert.equal(afterWaitingNotice.pendingInteraction?.id, "approval:approval-1");
  assert.equal(isChatRunActive(afterWaitingNotice), true);
});

test("completion, interruption, and error are authoritative run terminators", () => {
  const active: ChatSession = {
    ...ready,
    status: "streaming",
    streamingMessageId: "agent-1",
    messages: [
      { id: "tool-1", from: "tool", body: "running", at: "00:00", status: "streaming" },
      { id: "agent-1", from: "agent", body: "done", at: "00:01", status: "streaming" }
    ]
  };
  const complete = reduceChatGatewayEvent(active, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "agent-1", text: "done" }
  });
  assert.equal(isChatRunActive(complete), false);
  assert.deepEqual(complete.messages.map(({ status }) => status), ["complete", "complete"]);

  const error = reduceChatGatewayEvent(active, {
    type: "error", liveSessionId: "live", payload: { message: "failed" }
  });
  assert.equal(isChatRunActive(error), false);
  assert.deepEqual(error.messages.map(({ status }) => status), ["failed", "failed"]);

  const pending = reduceChatGatewayEvent(active, {
    type: "approval.request", liveSessionId: "live",
    payload: { approvalId: "approval-1", choices: ["once"], allowPermanent: false }
  });
  const pendingError = reduceChatGatewayEvent(pending, {
    type: "error", liveSessionId: "live", payload: { message: "failed" }
  });
  assert.equal(pendingError.pendingInteraction, undefined);
  assert.equal(isChatRunActive(pendingError), false);

  const interrupts: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {},
    interrupt(sessionId) { interrupts.push(sessionId); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [active];
  interruptSession(active.id);
  interruptSession(active.id);
  assert.deepEqual(interrupts, [active.id]);
  assert.equal(isChatRunActive(sessions.value[0]!), false);
  assert.deepEqual(sessions.value[0]?.messages.map(({ status }) => status), ["cancelled", "cancelled"]);

  sessions.value = [pending];
  interruptSession(active.id);
  interruptSession(active.id);
  assert.deepEqual(interrupts, [active.id, active.id]);
  assert.equal(sessions.value[0]?.pendingInteraction, undefined);
  assert.equal(isChatRunActive(sessions.value[0]!), false);
});
