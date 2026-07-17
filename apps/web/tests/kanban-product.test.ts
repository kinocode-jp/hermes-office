import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TaskComment, WorkTask } from "../src/domain.ts";
import { createTaskCommentController } from "../src/kanban-comments.ts";
import { MAX_VISIBLE_COMMENTS, normalizeCardDetail, type KanbanApi, type KanbanCardDetailResult } from "../src/kanban-api.ts";
import { requestTaskMove } from "../src/components/kanban-board.tsx";
import {
  addTaskComment,
  assignTask,
  refreshKanbanBoard,
  registerKanbanRuntime,
  taskCommentDetail,
  tasks,
  toggleTaskComments
} from "../src/store.ts";

const CARD: WorkTask = {
  id: "card-1",
  title: "Keyboard and touch",
  status: "todo",
  priority: "normal",
  comments: 0
};

test("card detail normalization is identity-bound, strict, de-duplicated, and render-bounded", () => {
  const comments = Array.from({ length: MAX_VISIBLE_COMMENTS + 1 }, (_, index) => rawComment(index + 1));
  const detail = normalizeCardDetail({ card: rawCard(comments.length), comments }, CARD.id);

  assert.equal(detail.comments.length, MAX_VISIBLE_COMMENTS);
  assert.equal(detail.comments[0]?.id, 2);
  assert.equal(detail.availableCommentCount, MAX_VISIBLE_COMMENTS + 1);
  assert.equal(detail.truncated, true);
  assert.throws(() => normalizeCardDetail({ card: { ...rawCard(1), id: "other" }, comments: [] }, CARD.id), /invalid/);
  assert.throws(() => normalizeCardDetail({ card: rawCard(1), comments: [{ ...rawComment(1), cardId: "other" }] }, CARD.id), /invalid/);
  assert.throws(() => normalizeCardDetail({ card: rawCard(2), comments: [rawComment(1), rawComment(1)] }, CARD.id), /invalid/);
  assert.throws(() => normalizeCardDetail({ card: rawCard(1), comments: [{ ...rawComment(1), body: "x".repeat(16_001) }] }, CARD.id), /invalid/);
  assert.throws(() => normalizeCardDetail({ card: rawCard(1), comments: [{ ...rawComment(1), createdAt: Number.MAX_SAFE_INTEGER }] }, CARD.id), /invalid/);
});

test("comment detail ignores stale pane loads and supports retry", async () => {
  const requests = new Map<string, ReturnType<typeof deferred<KanbanCardDetailResult>>>();
  const api = fakeApi({
    fetchCard: (cardId) => {
      const request = deferred<KanbanCardDetailResult>();
      requests.set(cardId, request);
      return request.promise;
    }
  });
  const controller = createTaskCommentController(() => api);

  const first = controller.toggle("card-a");
  const second = controller.toggle("card-b");
  requests.get("card-b")!.resolve(detail("card-b", [comment(2, "card-b", "current")]));
  await second;
  requests.get("card-a")!.resolve(detail("card-a", [comment(1, "card-a", "stale")]));
  await first;
  assert.equal(controller.taskCommentDetail.value.cardId, "card-b");
  assert.deepEqual(controller.taskCommentDetail.value.comments.map((item) => item.body), ["current"]);

  const retryRequest = controller.retry();
  requests.get("card-b")!.reject(new Error("offline"));
  await retryRequest;
  assert.equal(controller.taskCommentDetail.value.state, "error");
  const recovered = controller.retry();
  requests.get("card-b")!.resolve(detail("card-b", [comment(3, "card-b", "recovered")]));
  await recovered;
  assert.equal(controller.taskCommentDetail.value.state, "ready");
  assert.deepEqual(controller.taskCommentDetail.value.comments.map((item) => item.body), ["recovered"]);
});

test("status select and drag/drop share the validated move path", async () => {
  const source = await readFile(new URL("../src/components/kanban-board.tsx", import.meta.url), "utf8");
  assert.match(source, /onChange=.*requestTaskMove/s);
  assert.match(source, /onDrop=.*requestTaskMove/s);

  let boardCard = { ...CARD };
  const updates: Array<Record<string, unknown>> = [];
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([boardCard]),
    updateCard: async (_cardId, patch) => {
      updates.push(patch);
      boardCard = { ...boardCard, ...patch, assigneeId: patch.assignee ?? boardCard.assigneeId };
      return boardCard;
    }
  }));
  await refreshKanbanBoard();

  await requestTaskMove(CARD.id, "blocked");
  await requestTaskMove(CARD.id, "running");
  assert.deepEqual(updates, [{ status: "blocked" }]);
  assert.equal(tasks.value.find((task) => task.id === CARD.id)?.status, "blocked");
});

test("authoritative board refresh wins over an in-flight card mutation", async () => {
  let boardCard = { ...CARD };
  const patch = deferred<WorkTask>();
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([boardCard]),
    updateCard: async () => patch.promise
  }));
  await refreshKanbanBoard();

  const moving = requestTaskMove(CARD.id, "blocked");
  assert.equal(tasks.value[0]?.status, "blocked");
  boardCard = { ...boardCard, status: "done", assigneeId: "external-agent" };
  await refreshKanbanBoard();
  patch.resolve({ ...CARD, status: "blocked" });
  await moving;

  assert.equal(tasks.value[0]?.status, "done");
  assert.equal(tasks.value[0]?.assigneeId, "external-agent");
  assert.equal(tasks.value[0]?.pending, false);
});

test("a failed assignment cannot roll back an external board update", async () => {
  let boardCard = { ...CARD, assigneeId: "first-agent" };
  const patch = deferred<WorkTask>();
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([boardCard]),
    updateCard: async () => patch.promise
  }));
  await refreshKanbanBoard();

  const assigning = assignTask(CARD.id, "second-agent");
  boardCard = { ...boardCard, status: "ready", assigneeId: "external-agent" };
  await refreshKanbanBoard();
  patch.reject(new Error("conflict"));
  await assigning;

  assert.equal(tasks.value[0]?.status, "ready");
  assert.equal(tasks.value[0]?.assigneeId, "external-agent");
  assert.equal(tasks.value[0]?.pending, false);
});

test("comment submission reconciles from detail without duplicate local appends", async () => {
  let comments: TaskComment[] = [];
  let boardCard = { ...CARD };
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([boardCard]),
    fetchCard: async () => detail(CARD.id, comments),
    addComment: async (_cardId, body) => {
      comments = [...comments, comment(1, CARD.id, body)];
      boardCard = { ...boardCard, comments: comments.length };
    }
  }));
  await refreshKanbanBoard();
  await toggleTaskComments(CARD.id);

  assert.equal(await addTaskComment(CARD.id, "one note"), true);
  await waitUntil(() => taskCommentDetail.value.state === "ready" && taskCommentDetail.value.comments.length === 1);
  await refreshKanbanBoard();
  await waitUntil(() => taskCommentDetail.value.state === "ready");
  assert.deepEqual(taskCommentDetail.value.comments.map((item) => item.body), ["one note"]);
  assert.equal(tasks.value[0]?.comments, 1);
  await toggleTaskComments(CARD.id);
});

function fakeApi(overrides: Partial<KanbanApi>): KanbanApi {
  return {
    fetchBoard: async () => board([CARD]),
    fetchCard: async (cardId) => detail(cardId, []),
    createCard: async () => CARD,
    updateCard: async () => CARD,
    addComment: async () => {},
    ...overrides
  };
}

function board(cards: WorkTask[]) {
  return { tasks: cards, assignees: ["external-agent"], latestEventId: 1 };
}

function detail(cardId: string, comments: TaskComment[]): KanbanCardDetailResult {
  return {
    card: { ...CARD, id: cardId, comments: comments.length },
    comments,
    availableCommentCount: comments.length,
    truncated: false
  };
}

function comment(id: number, cardId: string, body: string): TaskComment {
  return { id, cardId, author: "hermes-office", body, createdAt: 100 + id };
}

function rawCard(commentCount: number) {
  return {
    id: CARD.id,
    title: CARD.title,
    body: null,
    assignee: null,
    status: CARD.status,
    priority: 0,
    createdAt: 100,
    startedAt: null,
    completedAt: null,
    latestSummary: null,
    commentCount
  };
}

function rawComment(id: number) {
  return { id, cardId: CARD.id, author: "hermes-office", body: `note ${id}`, createdAt: 100 + id };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for Kanban state.");
}
