import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import { canSubmitChatPrompt, mergeServerSessionStatus } from "../src/session-runtime.ts";
import { registerChatRuntime, sendMessage, sessions } from "../src/store.ts";

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
