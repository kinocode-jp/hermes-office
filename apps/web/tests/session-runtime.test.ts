import assert from "node:assert/strict";
import test from "node:test";
import type { ChatPromptResult, ChatSteerResult } from "../src/chat-api.ts";
import type { ChatSession } from "../src/domain.ts";
import { chatMessageBody, chatSessionTitle, locale, localizeRuntimeMessage, officeMessage, officeRuntimeMessage, setLocale, t } from "../src/i18n.ts";
import { buildChatTimeline, chatComposerState, formatChatMessageTime, nextOperationAnnouncement, operationAnnouncementText, presentedOperationEvidence, shouldSubmitComposerKey } from "../src/components/chat-pane.tsx";
import { canSteerChatSession, canSubmitChatPrompt, isChatRunActive, mergeGatewayStatusUpdate, mergeServerSessionStatus } from "../src/session-runtime.ts";
import { boundedSteerEvidence, MAX_STEER_EVIDENCE_BYTES, MAX_STEER_EVIDENCE_COUNT } from "../src/chat-run-actions.ts";
import {
  applyChatHistory,
  closeSession,
  interruptSession,
  openSessionIds,
  reduceChatGatewayEvent,
  registerChatRuntime,
  reconcilePromptOperationsWithHistory,
  sendMessage,
  sessions,
  setChatHistoryLoading,
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
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt(_sessionId, text) { submitted.push(text); },
    async respondClarify() {}, async respondApproval() {}
  });

  sessions.value = [{ ...ready }];
  sendMessage(ready.id, "first");
  sendMessage(ready.id, "second");
  assert.deepEqual(submitted, ["first"]);
  assert.equal(sessions.value[0]?.messages.filter((message) => message.from === "user").length, 0);
  assert.equal(sessions.value[0]?.operationEvidence?.length, 1);
  assert.equal(Number.isNaN(Date.parse(sessions.value[0]!.operationEvidence![0]!.at)), false);

  sessions.value = [{ ...ready, streamingMessageId: "hidden-live" }];
  sendMessage(ready.id, "marker");
  sessions.value = [{ ...ready, messages: [{ id: "hidden", from: "agent", body: "", at: "00:00", status: "streaming" }] }];
  sendMessage(ready.id, "message");
  sessions.value = [{ ...ready, status: "waiting" }];
  sendMessage(ready.id, "waiting");
  assert.deepEqual(submitted, ["first"]);
});

test("prompt submissions expose pending, accepted, rejected, and commit-unknown states without automatic replay", async () => {
  const submission = deferred<ChatPromptResult>();
  const calls: Array<{ text: string; operationId: string }> = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, interrupt() {}, async steer() { return { status: "queued" }; },
    submitPrompt(_sessionId, text, operationId) { calls.push({ text, operationId }); return submission.promise; },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready }];
  sendMessage(ready.id, "deploy once");
  const pending = sessions.value[0]!.operationEvidence![0]!;
  assert.equal(pending.state, "pending");
  assert.equal(pending.kind, "prompt");
  assert.equal(sessions.value[0]!.messages.length, 0, "local RPC evidence must not corrupt the durable transcript");
  assert.equal(calls.length, 1);

  submission.resolve({ status: "unconfirmed", message: "socket closed after send" });
  await Promise.resolve();
  assert.equal(sessions.value[0]!.operationEvidence![0]!.state, "unconfirmed");
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), true, "the operator may decide what to do after reviewing commit-unknown evidence");
  assert.equal(calls.length, 1, "commit-unknown prompts must never be replayed automatically");

  for (const result of [
    { status: "accepted" } as const,
    { status: "rejected", message: "policy denied" } as const,
  ]) {
    sessions.value = [{ ...ready }];
    registerChatRuntime({
      ensureSession() {}, releaseSession() {}, interrupt() {}, async steer() { return { status: "queued" }; },
      async submitPrompt() { return result; }, async respondClarify() {}, async respondApproval() {},
    });
    sendMessage(ready.id, result.status);
    await Promise.resolve();
    assert.equal(sessions.value[0]!.operationEvidence![0]!.state, result.status);
    assert.equal(sessions.value[0]!.messages.length, 0);
  }
});

test("authoritative history preserves prompt operation evidence without a durable operation id", () => {
  const at = "2026-07-17T01:00:00.000Z";
  const operation = (id: string, body: string, state: "accepted" | "rejected" | "unconfirmed") => ({
    id, kind: "prompt" as const, body, at, state,
  });
  const local = [operation("accepted", "same", "accepted"), operation("rejected", "same", "rejected"), operation("unknown", "other", "unconfirmed")];
  const history = [{ id: "remote", from: "user" as const, body: "same", at, status: "complete" as const }];
  assert.deepEqual(reconcilePromptOperationsWithHistory(local, history).map(({ id }) => id), ["accepted", "rejected", "unknown"]);
});

test("old or timestamp-free same-text history never erases newer accepted operation evidence", () => {
  const local = [{
    id: "accepted-new", kind: "prompt" as const, body: "repeatable command", at: "2026-07-17T10:00:00.000Z",
    state: "accepted" as const,
  }];
  for (const at of ["", "12:00", "2025-07-17T10:00:00.000Z"]) {
    const history = [{ id: `old-${at}`, from: "user" as const, body: "repeatable command", at, status: "complete" as const }];
    assert.deepEqual(reconcilePromptOperationsWithHistory(local, history).map(({ id }) => id), ["accepted-new"]);
  }
  const closeInTime = [{ id: "close-in-time", from: "user" as const, body: "repeatable command", at: "2026-07-17T10:00:01.000Z", status: "complete" as const }];
  assert.deepEqual(reconcilePromptOperationsWithHistory(local, closeInTime).map(({ id }) => id), ["accepted-new"]);
});

test("legacy local operations migrate into a bounded ledger without duplicating or reordering the durable transcript", () => {
  const legacy: ChatSession = {
    ...ready,
    messages: [
      { id: "durable-old", from: "agent", body: "old durable", at: "10:00", status: "complete" },
      { id: "local-op", from: "user", body: "repeat", at: "10:01", promptOperation: { id: "op-1", state: "accepted" } },
    ],
    operationEvidence: [{ id: "op-0", kind: "prompt", body: "uncertain", at: "09:59", state: "unconfirmed" }],
  };
  assert.deepEqual(presentedOperationEvidence(legacy).map(({ id }) => id), ["op-0", "op-1"]);
  sessions.value = [legacy];
  setChatHistoryLoading(ready.id, true);
  applyChatHistory(ready.id, [
    { id: "history-1", from: "user", body: "repeat", at: "10:02", status: "complete" },
    { id: "history-2", from: "agent", body: "done", at: "10:03", status: "complete" },
  ]);
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), ["history-1", "history-2"]);
  assert.deepEqual(sessions.value[0]?.operationEvidence?.map(({ id }) => id), ["op-0", "op-1"]);
});

test("separate operation evidence is presented in conversation chronology without same-body deduplication", () => {
  const messages = [
    { id: "durable-1", from: "user" as const, body: "repeat", at: "2026-07-17T10:00:00.000Z" },
    { id: "durable-2", from: "agent" as const, body: "done", at: "2026-07-17T10:02:00.000Z" },
  ];
  const evidence = [
    { id: "operation-1", kind: "prompt" as const, body: "repeat", at: "2026-07-17T10:01:00.000Z", state: "accepted" as const },
    { id: "operation-2", kind: "prompt" as const, body: "later", at: "2026-07-17T10:03:00.000Z", state: "unconfirmed" as const },
  ];
  const timeline = buildChatTimeline(messages, evidence);
  assert.deepEqual(timeline.map((item) => item.kind === "message" ? item.message.id : item.operation.id), [
    "durable-1", "operation-1", "durable-2", "operation-2",
  ]);
  assert.equal(timeline.filter((item) => (item.kind === "message" ? item.message.body : item.operation.body) === "repeat").length, 2);

  const mixedClock = buildChatTimeline(messages, [{ ...evidence[0]!, at: "10:01" }]);
  assert.deepEqual(mixedClock.map((item) => item.kind), ["message", "message", "operation"], "incomparable timestamp families preserve source order instead of guessing causality");
});

test("operation live announcements emit only the latest changed id/state", () => {
  const previousLocale = locale.value;
  const operation = { id: "operation", kind: "prompt" as const, body: "deploy", at: "12:00", state: "pending" as const };
  try {
    setLocale("ja");
    const pending = nextOperationAnnouncement([operation], "")!;
    assert.equal(nextOperationAnnouncement([operation], pending.key), undefined);
    const accepted = nextOperationAnnouncement([{ ...operation, state: "accepted" }], pending.key)!;
    assert.notEqual(accepted.key, pending.key);
    assert.match(operationAnnouncementText(accepted.operation), /指示.*Hermes受理済み.*deploy/);
  } finally {
    setLocale(previousLocale);
  }
});

test("chat timestamps render by selected locale without rewriting legacy clock text", () => {
  const timestamp = "2026-07-16T01:02:03.000Z";
  const date = new Date(timestamp);
  const japanese = formatChatMessageTime(timestamp, "ja", "Asia/Tokyo");
  const english = formatChatMessageTime(timestamp, "en", "Asia/Tokyo");
  assert.equal(japanese, new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(date));
  assert.equal(english, new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(date));
  assert.notEqual(japanese, english);
  assert.equal(formatChatMessageTime("12:00", "ja", "Asia/Tokyo"), "12:00");
  assert.equal(formatChatMessageTime("12:00", "en", "Asia/Tokyo"), "12:00");
  assert.equal(formatChatMessageTime("legacy timestamp", "en", "Asia/Tokyo"), "legacy timestamp");
});

test("active runs steer once without changing authoritative run state", async () => {
  const requests: Array<{ sessionId: string; text: string }> = [];
  const operation = deferred<void>();
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
    async steer(sessionId, text) { requests.push({ sessionId, text }); await operation.promise; return { status: "queued" }; },
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
  assert.deepEqual(sessions.value[0]?.operationEvidence?.map(({ kind, body, state }) => ({ kind, body, state })), [
    { kind: "steer", body: "add mobile coverage", state: "accepted" },
  ]);
  sessions.value = [reduceChatGatewayEvent(sessions.value[0]!, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "agent-done", text: "done" }
  })];
  assert.equal(sessions.value[0]?.operationEvidence?.filter(({ kind }) => kind === "steer").length, 1);
});

test("accepted Steer evidence is deterministically bounded by count and UTF-8 bytes without body dedupe", () => {
  const countBound = Array.from({ length: MAX_STEER_EVIDENCE_COUNT + 1 }, (_, index) => ({
    id: `steer-${index}`, from: "user" as const, kind: "steer" as const, body: "same body", at: "12:00",
  }));
  assert.deepEqual(boundedSteerEvidence(countBound).map(({ id }) => id), countBound.slice(1).map(({ id }) => id));

  const largeBody = "界".repeat(Math.ceil(MAX_STEER_EVIDENCE_BYTES / 6));
  const byteBound = [
    { id: "old", from: "user" as const, kind: "steer" as const, body: largeBody, at: "12:00" },
    { id: "new", from: "user" as const, kind: "steer" as const, body: largeBody, at: "12:01" },
  ];
  assert.deepEqual(boundedSteerEvidence(byteBound).map(({ id }) => id), ["new"]);
});

test("steer eligibility fails closed while idle, disconnected, empty, or awaiting interaction", async () => {
  const requests: string[] = [];
  const prompts: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, interrupt() {},
    submitPrompt(_sessionId, text) { prompts.push(text); },
    async steer(_sessionId, text) { requests.push(text); return { status: "queued" }; },
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

test("steering labels, placeholders, and failures are localized without overstating queue acceptance", () => {
  const previous = locale.value;
  try {
    setLocale("ja");
    assert.deepEqual([t("chat.steer"), t("chat.steerPlaceholder"), t("chat.steerMessage")], ["追加指示", "実行中のHermesに追加指示…", "Hermesキュー受理"]);
    setLocale("en");
    assert.deepEqual([t("chat.steer"), t("chat.steerPlaceholder"), t("chat.steerMessage")], ["Steer", "Add guidance for the running Hermes session…", "Accepted by Hermes queue"]);
    assert.match(localizeRuntimeMessage(officeRuntimeMessage("追加指示を送信できませんでした。接続を確認して再試行してください。")), /Unable to send steering guidance/);
  } finally { setLocale(previous); }
});

test("Office-owned chat titles, tool fallbacks, and transport copy switch locale without translating Hermes text", () => {
  const previous = locale.value;
  const draft = { title: "", titlePresentation: "new-chat" as const };
  const HermesTitle = { title: "ユーザーがHermesに付けた題名" };
  const tool = reduceChatGatewayEvent(ready, {
    type: "tool.start", liveSessionId: "live", payload: { toolId: "tool-1", name: "Shell" },
  }).messages[0]!;
  const genericTool = reduceChatGatewayEvent(ready, {
    type: "tool.complete", liveSessionId: "live", payload: { toolId: "tool-2" },
  }).messages[0]!;
  const HermesDetail = reduceChatGatewayEvent(ready, {
    type: "tool.start", liveSessionId: "live", payload: { toolId: "tool-3", name: "Shell", summary: "利用者由来の要約" },
  }).messages[0]!;
  try {
    setLocale("ja");
    assert.equal(chatSessionTitle(draft), "新しい会話");
    assert.equal(chatMessageBody(tool), "Shellを実行中…");
    assert.equal(chatMessageBody(genericTool), "ツール 完了");
    setLocale("en");
    assert.equal(chatSessionTitle(draft), "New chat");
    assert.equal(chatSessionTitle(HermesTitle), HermesTitle.title);
    assert.equal(chatMessageBody(tool), "Running Shell…");
    assert.equal(chatMessageBody(genericTool), "Tool complete");
    assert.equal(chatMessageBody(HermesDetail), "Shell: 利用者由来の要約");
    for (const [message, expected] of [
      [officeRuntimeMessage("端末の再認証が必要です。"), "This device must be authenticated again."],
      [officeRuntimeMessage("接続復旧後に履歴を再同期します"), "History will be resynchronized after the connection recovers."],
      [officeRuntimeMessage("session.resumeがタイムアウトしました。"), "session.resume timed out."],
      [officeRuntimeMessage("送信結果を確認するための保存済み履歴IDを取得できませんでした。明示的に再接続してください。"), "The saved history ID needed to confirm the submission was not returned. Reconnect explicitly."],
      [officeRuntimeMessage("保存済み履歴の完全性を確認できませんでした。明示的に再試行してください。"), "Saved-history integrity could not be confirmed. Retry explicitly."],
      [officeRuntimeMessage("Hermesが不正な送信確認を返しました。保存済み履歴を再確認します。"), "Hermes returned an invalid submission acknowledgement. Reloading saved history."],
      [officeMessage("runtime.office.demo"), "Showing explicit demo mode"],
      [officeMessage("runtime.kanban.waiting"), "Waiting for the Hermes runtime"],
      [officeMessage("runtime.kanban.commenting"), "Sending comment"],
    ] as const) assert.equal(localizeRuntimeMessage(message), expected);
    assert.equal(localizeRuntimeMessage("Hermesが生成した日本語の自由文"), "Hermesが生成した日本語の自由文");
    const collision = reduceChatGatewayEvent(ready, {
      type: "error", liveSessionId: "live", payload: { message: "端末の再認証が必要です。" },
    });
    assert.equal(localizeRuntimeMessage(collision.errorMessage!), "端末の再認証が必要です。");
    assert.equal(localizeRuntimeMessage(officeRuntimeMessage("Office WebSocketへ再接続できませんでした。手動で再試行してください。")), "Unable to reconnect to the Office WebSocket. Retry manually.");
  } finally { setLocale(previous); }
});

test("composer Enter ignores IME composition in prompt and steer modes", () => {
  const ordinaryEnter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
  for (const current of [ready, { ...ready, status: "streaming" as const }]) {
    assert.equal(chatComposerState(current).canCompose, true);
    assert.equal(shouldSubmitComposerKey({ ...ordinaryEnter, isComposing: true }), false);
    assert.equal(shouldSubmitComposerKey({ ...ordinaryEnter, keyCode: 229 }), false);
    assert.equal(shouldSubmitComposerKey({ ...ordinaryEnter, shiftKey: true }), false);
    assert.equal(shouldSubmitComposerKey(ordinaryEnter), true);
  }
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
  assert.match(localizeRuntimeMessage(sessions.value[0]!.errorMessage!), /追加指示/);
});

test("rejected and malformed steering acknowledgements retain input and never add a success message", async (context) => {
  for (const result of [{ status: "rejected" }, { status: "invalid" }] as const) {
    await context.test(result.status, async () => {
      registerChatRuntime({
        ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
        async steer() { return result; },
        async respondClarify() {}, async respondApproval() {}
      });
      sessions.value = [{ ...ready, status: "streaming" }];
      assert.equal(await steerSession(ready.id, `keep ${result.status}`), false);
      assert.equal(sessions.value[0]?.steerPending, false);
      assert.equal(sessions.value[0]?.messages.some(({ kind }) => kind === "steer"), false);
      assert.match(localizeRuntimeMessage(sessions.value[0]!.errorMessage!), result.status === "rejected" ? /拒否/ : /受付結果/);
      sessions.value = [reduceChatGatewayEvent(sessions.value[0]!, {
        type: "message.complete", liveSessionId: "live", payload: { messageId: "agent-done", text: "done" }
      })];
      assert.equal(sessions.value[0]?.messages.some(({ kind }) => kind === "steer"), false);
    });
  }
});

test("a delayed steer acknowledgement cannot overwrite a local stop", async () => {
  const operation = deferred<void>();
  const interrupts: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {},
    async steer() { await operation.promise; return { status: "queued" }; },
    interrupt(sessionId) { interrupts.push(sessionId); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready, status: "streaming" }];
  const steering = steerSession(ready.id, "late guidance");
  const stopping = interruptSession(ready.id);
  assert.equal(sessions.value[0]?.interruptPending, true);
  operation.resolve();
  assert.equal(await stopping, true);
  assert.equal(await steering, false);
  assert.deepEqual(interrupts, [ready.id]);
  assert.equal(sessions.value[0]?.status, "ready");
  assert.equal(sessions.value[0]?.messages.length, 0);
});

test("stop blocks duplicate prompts until acknowledgement and restores the active run on failure", async () => {
  const operation = deferred<void>();
  const prompts: string[] = [];
  let interruptCalls = 0;
  registerChatRuntime({
    ensureSession() {}, releaseSession() {},
    submitPrompt(_sessionId, text) { prompts.push(text); },
    async steer() { return { status: "queued" }; },
    interrupt() { interruptCalls += 1; return operation.promise; },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready, status: "streaming", streamingMessageId: "agent-active", messages: [{ id: "agent-active", from: "agent", body: "working", at: "00:00", status: "streaming" }] }];
  const stopping = interruptSession(ready.id);
  assert.equal(sessions.value[0]?.interruptPending, true);
  assert.equal(sessions.value[0]?.status, "streaming");
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
  sendMessage(ready.id, "must stay blocked");
  assert.deepEqual(prompts, []);
  assert.equal(await interruptSession(ready.id), false);
  assert.equal(interruptCalls, 1);
  operation.reject(new Error("network failure"));
  assert.equal(await stopping, false);
  assert.equal(sessions.value[0]?.interruptPending, false);
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(sessions.value[0]?.messages[0]?.status, "streaming");
  assert.match(localizeRuntimeMessage(sessions.value[0]!.errorMessage!), /停止を確認できません/);

  const uncorrelatedIdle = reduceChatGatewayEvent({ ...sessions.value[0]!, interruptPending: true, interruptOperationId: "stop-2" }, {
    type: "session.info", liveSessionId: "live", payload: { running: false, status: "idle" },
  });
  assert.equal(uncorrelatedIdle.interruptPending, true);
  assert.equal(isChatRunActive(uncorrelatedIdle), true);
  const staleTerminal = reduceChatGatewayEvent(uncorrelatedIdle, {
    type: "message.complete", liveSessionId: "stale-live", payload: { messageId: "agent-active", text: "stale" },
  });
  assert.equal(staleTerminal, uncorrelatedIdle);
  assert.equal(staleTerminal.interruptPending, true);
});

test("same-target terminal events retain steering until queued or rejected acknowledgement", async (context) => {
  for (const terminal of ["message.complete", "error"] as const) {
    for (const outcome of ["queued", "rejected"] as const) {
      await context.test(`${terminal} before ${outcome}`, async () => {
        const operation = deferred<ChatSteerResult>();
        const prompts: string[] = [];
        registerChatRuntime({
          ensureSession() {}, releaseSession() {}, interrupt() {},
          submitPrompt(_sessionId, text) { prompts.push(text); },
          async steer() { return operation.promise; },
          async respondClarify() {}, async respondApproval() {}
        });
        sessions.value = [{
          ...ready,
          status: "streaming",
          streamingMessageId: "old-agent",
          messages: [{ id: "old-agent", from: "agent", body: "old run", at: "00:00", status: "streaming" }],
        }];

        const pendingSteer = steerSession(ready.id, `${terminal} ${outcome}`);
        sessions.value = [reduceChatGatewayEvent(sessions.value[0]!, terminal === "message.complete" ? {
          type: terminal, liveSessionId: "live", payload: { messageId: "old-agent", text: "old done" }
        } : {
          type: terminal, liveSessionId: "live", payload: { message: "old failed" }
        })];
        assert.ok(sessions.value[0]?.steerOperationId);
        assert.equal(sessions.value[0]?.steerPending, true);
        assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
        sendMessage(ready.id, "new prompt");
        assert.deepEqual(prompts, []);

        operation.resolve({ status: outcome });
        assert.equal(await pendingSteer, outcome === "queued");
        assert.equal(sessions.value[0]?.steerPending, false);
        assert.equal(sessions.value[0]?.operationEvidence?.filter(({ kind }) => kind === "steer").length ?? 0, outcome === "queued" ? 1 : 0);
        assert.equal(canSubmitChatPrompt(sessions.value[0]!), true);
        if (outcome === "rejected") assert.match(localizeRuntimeMessage(sessions.value[0]!.errorMessage!), /拒否/);
      });
    }
  }
});

test("disconnect, live target replacement, and close invalidate pending steer acknowledgements", async (context) => {
  const scenarios = ["disconnect", "target", "close"] as const;
  for (const scenario of scenarios) {
    await context.test(scenario, async () => {
      const operation = deferred<void>();
      const released: string[] = [];
      registerChatRuntime({
        ensureSession() {}, submitPrompt() {}, interrupt() {},
        releaseSession(sessionId) { released.push(sessionId); },
        async steer() { await operation.promise; return { status: "queued" }; },
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

      if (scenario === "disconnect") {
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
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
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

test("completion, interruption, and error are authoritative run terminators", async () => {
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
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, async steer() { return { status: "queued" }; },
    interrupt(sessionId) { interrupts.push(sessionId); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [active];
  const firstStop = interruptSession(active.id);
  const duplicateStop = interruptSession(active.id);
  assert.deepEqual(interrupts, [active.id]);
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(await duplicateStop, false);
  assert.equal(await firstStop, true);
  assert.equal(isChatRunActive(sessions.value[0]!), false);
  assert.deepEqual(sessions.value[0]?.messages.map(({ status }) => status), ["cancelled", "cancelled"]);

  sessions.value = [pending];
  const pendingStop = interruptSession(active.id);
  const duplicatePendingStop = interruptSession(active.id);
  assert.deepEqual(interrupts, [active.id, active.id]);
  assert.equal(await duplicatePendingStop, false);
  assert.equal(await pendingStop, true);
  assert.equal(sessions.value[0]?.pendingInteraction, undefined);
  assert.equal(isChatRunActive(sessions.value[0]!), false);
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
