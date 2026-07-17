import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import { locale, localizeRuntimeMessage, setLocale, t } from "../src/i18n.ts";
import { chatComposerState } from "../src/components/chat-pane.tsx";
import { canSteerChatSession, canSubmitChatPrompt, isChatRunActive, mergeGatewayStatusUpdate, mergeServerSessionStatus } from "../src/session-runtime.ts";
import {
  closeSession,
  interruptSession,
  openSessionIds,
  reduceChatGatewayEvent,
  registerChatRuntime,
  sendMessage,
  sessions,
  setChatSessionDisconnected,
  setChatSessionReady,
  steerSession,
} from "../src/store.ts";

const ready: ChatSession = {
  id: "client", storedSessionId: "stored", liveSessionId: "live", profileId: "profile", title: "Session",
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
    ensureSession() {}, releaseSession() {}, async steer() {}, interrupt() {},
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

test("active runs steer once without changing authoritative run state", async () => {
  const requests: Array<{ sessionId: string; text: string }> = [];
  const operation = deferred<void>();
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
    async steer(sessionId, text) { requests.push({ sessionId, text }); await operation.promise; },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready, status: "streaming", liveSessionId: "live" }];
  const first = steerSession(ready.id, "  add mobile coverage  ");
  const duplicate = await steerSession(ready.id, "duplicate");
  assert.equal(duplicate, false);
  assert.deepEqual(requests, [{ sessionId: ready.id, text: "add mobile coverage" }]);
  assert.equal(sessions.value[0]?.steerPending, true);
  assert.equal(sessions.value[0]?.status, "streaming");
  assert.equal(sessions.value[0]?.messages.length, 0);
  operation.resolve();
  assert.equal(await first, true);
  assert.equal(sessions.value[0]?.status, "streaming");
  assert.equal(sessions.value[0]?.steerPending, false);
  assert.deepEqual(sessions.value[0]?.messages.map(({ from, kind, body }) => ({ from, kind, body })), [
    { from: "user", kind: "steer", body: "add mobile coverage" },
  ]);
});

test("steer eligibility fails closed while idle, disconnected, empty, or awaiting interaction", async () => {
  const requests: string[] = [];
  const prompts: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, interrupt() {},
    submitPrompt(_sessionId, text) { prompts.push(text); },
    async steer(_sessionId, text) { requests.push(text); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready }];
  assert.equal(await steerSession(ready.id, "idle steer"), false);
  assert.equal(await steerSession(ready.id, " "), false);
  sendMessage(ready.id, "ordinary prompt");
  assert.deepEqual(prompts, ["ordinary prompt"]);

  const active = { ...ready, status: "streaming" as const };
  sessions.value = [{ ...active, connectionState: "disconnected" }];
  assert.equal(await steerSession(ready.id, "offline"), false);
  sessions.value = [{ ...active, pendingInteraction: { id: "clarify:1", kind: "clarify", requestId: "1", question: "Which?", choices: [], submitting: false } }];
  assert.equal(await steerSession(ready.id, "during clarification"), false);
  assert.deepEqual(requests, []);
});

test("running composer exposes Steer and Stop together but interactions take input priority", () => {
  const active = { ...ready, status: "streaming" as const };
  assert.deepEqual(chatComposerState(active), { runActive: true, canSteer: true, canCompose: true, showStop: true });
  assert.equal(canSteerChatSession(active), true);
  const waiting: ChatSession = {
    ...active, status: "waiting",
    pendingInteraction: { id: "approval:1", kind: "approval", approvalId: "1", choices: ["once"], allowPermanent: false, submitting: false },
  };
  assert.deepEqual(chatComposerState(waiting), { runActive: true, canSteer: false, canCompose: false, showStop: true });
  assert.deepEqual(chatComposerState(ready), { runActive: false, canSteer: false, canCompose: true, showStop: false });
});

test("steering labels, placeholders, and failures are localized in Japanese and English", () => {
  const previous = locale.value;
  try {
    setLocale("ja");
    assert.deepEqual([t("chat.steer"), t("chat.steerPlaceholder"), t("chat.steerMessage")], ["追加指示", "実行中のHermesに追加指示…", "追加指示"]);
    setLocale("en");
    assert.deepEqual([t("chat.steer"), t("chat.steerPlaceholder"), t("chat.steerMessage")], ["Steer", "Add guidance for the running Hermes session…", "Steering instruction"]);
    assert.match(localizeRuntimeMessage("追加指示を送信できませんでした。接続を確認して再試行してください。"), /Unable to send steering guidance/);
  } finally { setLocale(previous); }
});

test("failed steering keeps the run active and reports failure without a local message", async () => {
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
    async steer() { throw new Error("upstream unavailable"); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready, status: "streaming" }];
  assert.equal(await steerSession(ready.id, "keep going"), false);
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(sessions.value[0]?.messages.length, 0);
  assert.match(sessions.value[0]?.errorMessage ?? "", /追加指示/);
});

test("a delayed steer acknowledgement cannot overwrite a local stop", async () => {
  const operation = deferred<void>();
  const interrupts: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {},
    async steer() { await operation.promise; },
    interrupt(sessionId) { interrupts.push(sessionId); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready, status: "streaming" }];
  const steering = steerSession(ready.id, "late guidance");
  interruptSession(ready.id);
  operation.resolve();
  assert.equal(await steering, false);
  assert.deepEqual(interrupts, [ready.id]);
  assert.equal(sessions.value[0]?.status, "ready");
  assert.equal(sessions.value[0]?.messages.length, 0);
});

test("a terminal event followed by a new prompt rejects both successful and failed stale steer acknowledgements", async (context) => {
  for (const outcome of ["success", "failure"] as const) {
    await context.test(outcome, async () => {
      const operation = deferred<void>();
      const prompts: string[] = [];
      registerChatRuntime({
        ensureSession() {}, releaseSession() {}, interrupt() {},
        submitPrompt(_sessionId, text) { prompts.push(text); },
        async steer() { await operation.promise; },
        async respondClarify() {}, async respondApproval() {}
      });
      sessions.value = [{
        ...ready,
        status: "streaming",
        streamingMessageId: "old-agent",
        messages: [{ id: "old-agent", from: "agent", body: "old run", at: "00:00", status: "streaming" }],
      }];

      const staleSteer = steerSession(ready.id, `stale ${outcome}`);
      sessions.value = [reduceChatGatewayEvent(sessions.value[0]!, {
        type: "message.complete", liveSessionId: "live", payload: { messageId: "old-agent", text: "old done" }
      })];
      assert.equal(sessions.value[0]?.steerOperationId, undefined);
      sendMessage(ready.id, "new prompt");
      const nextRun = sessions.value[0]!;
      assert.equal(nextRun.status, "streaming");
      assert.deepEqual(prompts, ["new prompt"]);

      if (outcome === "success") operation.resolve();
      else operation.reject(new Error("late upstream rejection"));
      assert.equal(await staleSteer, false);
      assert.deepEqual(sessions.value[0], nextRun);
      assert.equal(sessions.value[0]?.errorMessage, undefined);
      assert.equal(sessions.value[0]?.messages.some(({ kind }) => kind === "steer"), false);
    });
  }
});

test("error, disconnect, live target replacement, and close invalidate pending steer acknowledgements", async (context) => {
  const scenarios = ["error", "disconnect", "target", "close"] as const;
  for (const scenario of scenarios) {
    await context.test(scenario, async () => {
      const operation = deferred<void>();
      const released: string[] = [];
      registerChatRuntime({
        ensureSession() {}, submitPrompt() {}, interrupt() {},
        releaseSession(sessionId) { released.push(sessionId); },
        async steer() { await operation.promise; },
        async respondClarify() {}, async respondApproval() {}
      });
      sessions.value = [{
        ...ready,
        status: "streaming",
        streamingMessageId: "agent-old",
        messages: [{ id: "agent-old", from: "agent", body: "working", at: "00:00", status: "streaming" }],
      }];
      openSessionIds.value = scenario === "close" ? [ready.id] : [];
      const staleSteer = steerSession(ready.id, `stale ${scenario}`);

      if (scenario === "error") {
        sessions.value = [reduceChatGatewayEvent(sessions.value[0]!, {
          type: "error", liveSessionId: "live", payload: { message: "run failed" }
        })];
      } else if (scenario === "disconnect") {
        setChatSessionDisconnected(ready.id);
      } else if (scenario === "target") {
        setChatSessionReady(ready.id, "live-replacement", "stored", { running: true });
      } else {
        closeSession(ready.id);
      }
      const invalidated = sessions.value[0]!;
      assert.equal(invalidated.steerOperationId, undefined);
      assert.equal(invalidated.steerPending, false);

      operation.resolve();
      assert.equal(await staleSteer, false);
      assert.deepEqual(sessions.value[0], invalidated);
      assert.equal(sessions.value[0]?.messages.some(({ kind }) => kind === "steer"), false);
      if (scenario === "disconnect") {
        assert.equal(invalidated.connectionState, "disconnected");
        assert.equal(invalidated.liveSessionId, undefined);
      } else if (scenario === "target") {
        assert.equal(invalidated.liveSessionId, "live-replacement");
        assert.equal(invalidated.status, "streaming");
        assert.equal(invalidated.messages[0]?.status, "cancelled");
      } else if (scenario === "close") {
        assert.deepEqual(released, [ready.id]);
        assert.deepEqual(openSessionIds.value, []);
        assert.equal(invalidated.connectionState, "disconnected");
        assert.equal(invalidated.liveSessionId, undefined);
        assert.equal(invalidated.status, "ready");
        assert.equal(invalidated.messages[0]?.status, "cancelled");
      }
    });
  }
});

test("canonical Hermes status notifications cannot create a run and preserve an active run", () => {
  const submitted: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() {}, interrupt() {},
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
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, async steer() {},
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
