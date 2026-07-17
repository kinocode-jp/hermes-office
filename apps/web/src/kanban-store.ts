import { signal } from "@preact/signals";
import type { KanbanConnectionState, TaskWritableStatus, WorkTask } from "./domain";
import type { KanbanApi } from "./kanban-api";
import { createTaskCommentController } from "./kanban-comments";

export const tasks = signal<WorkTask[]>([]);
export const kanbanAssignees = signal<string[]>([]);
export const kanbanState = signal<{ state: KanbanConnectionState; message: string; latestEventId: number }>({
  state: "idle",
  message: "Hermes Kanbanへ接続しています",
  latestEventId: 0
});

let kanbanApi: KanbanApi | undefined;
let liveKanbanApi: KanbanApi | undefined;
let demoRuntimeActive = false;
let kanbanMutations = 0;
let kanbanRefresh: Promise<void> | undefined;
let kanbanRefreshRequested = 0;
let kanbanRefreshCompleted = 0;
let boardGeneration = 0;
let runtimeGeneration = 0;
let operationGeneration = 0;
const currentOperations = new Map<string, number>();
let updateProfileTaskCounts = (_counts: ReadonlyMap<string, number>) => {};

const taskComments = createTaskCommentController(() => kanbanApi);
export const expandedTaskId = taskComments.expandedTaskId;
export const taskCommentDetail = taskComments.taskCommentDetail;
export const toggleTaskComments = taskComments.toggle;
export const retryTaskComments = taskComments.retry;

export function registerKanbanProfileTaskUpdater(update: (counts: ReadonlyMap<string, number>) => void): void {
  updateProfileTaskCounts = update;
}

export function registerKanbanRuntime(api: KanbanApi): void {
  liveKanbanApi = api;
  if (demoRuntimeActive) return;
  kanbanApi = api;
  runtimeGeneration += 1;
  void refreshKanbanBoard();
}

export function loadKanbanDemoRuntime(api: KanbanApi): void {
  demoRuntimeActive = true;
  kanbanApi = api;
  runtimeGeneration += 1;
  currentOperations.clear();
  kanbanMutations = 0;
  taskComments.collapse();
  tasks.value = [];
  kanbanAssignees.value = [];
  kanbanState.value = { state: "loading", message: "Hermes Kanbanを読み込み中", latestEventId: 0 };
  void refreshKanbanBoard();
}

export async function refreshKanbanBoard(): Promise<void> {
  if (!kanbanApi) return;
  const requested = ++kanbanRefreshRequested;
  while (kanbanRefreshCompleted < requested) {
    kanbanRefresh ??= drainKanbanRefreshes();
    await kanbanRefresh;
  }
}

async function drainKanbanRefreshes(): Promise<void> {
  try {
    while (kanbanRefreshCompleted < kanbanRefreshRequested) {
      const generation = kanbanRefreshRequested;
      await loadKanbanBoard();
      kanbanRefreshCompleted = generation;
    }
  } finally {
    kanbanRefresh = undefined;
  }
}

async function loadKanbanBoard(): Promise<void> {
  const api = kanbanApi!;
  const runtime = runtimeGeneration;
  kanbanState.value = { ...kanbanState.value, state: "loading", message: "Hermes Kanbanを読み込み中" };
  try {
    const board = await api.fetchBoard();
    if (api !== kanbanApi || runtime !== runtimeGeneration) return;
    boardGeneration += 1;
    tasks.value = board.tasks.map((task) => currentOperations.has(task.id) ? { ...task, pending: true } : task);
    kanbanAssignees.value = board.assignees;
    kanbanState.value = { state: "ready", message: `${board.tasks.length}件のカード`, latestEventId: board.latestEventId };
    notifyProfileTaskCounts();
    const expanded = expandedTaskId.value;
    if (expanded && !board.tasks.some((task) => task.id === expanded)) taskComments.collapse();
    else void taskComments.refreshIfExpanded();
  } catch (error) {
    if (api !== kanbanApi || runtime !== runtimeGeneration) return;
    setKanbanError(error);
  }
}

export function resetKanbanRuntimeState(): void {
  runtimeGeneration += 1;
  demoRuntimeActive = false;
  kanbanApi = liveKanbanApi;
  tasks.value = [];
  kanbanAssignees.value = [];
  taskComments.collapse();
  currentOperations.clear();
  kanbanMutations = 0;
  kanbanState.value = { state: "idle", message: "Hermes runtimeの準備を待っています", latestEventId: 0 };
  notifyProfileTaskCounts();
}

export async function assignTask(taskId: string, profileId: string | null): Promise<void> {
  if (!kanbanApi) return;
  const previous = tasks.value.find((task) => task.id === taskId);
  const nextAssignee = profileId ?? undefined;
  if (!previous || previous.pending || previous.assigneeId === nextAssignee) return;
  const operation = beginTaskOperation(taskId, { ...previous, assigneeId: nextAssignee });
  const startedAtBoard = boardGeneration;
  beginKanbanMutation("担当を更新中");
  try {
    await kanbanApi.updateCard(taskId, { assignee: profileId });
    await refreshKanbanBoard();
  } catch (error) {
    await refreshKanbanBoard();
    if (boardGeneration === startedAtBoard) rollbackAssignee(taskId, operation, nextAssignee, previous.assigneeId);
    failKanbanMutation(error);
    finishTaskOperation(taskId, operation);
    return;
  }
  finishTaskOperation(taskId, operation);
  finishKanbanMutation(boardGeneration === startedAtBoard);
}

export async function moveTask(taskId: string, status: TaskWritableStatus): Promise<void> {
  if (!kanbanApi) return;
  const previous = tasks.value.find((task) => task.id === taskId);
  if (!previous || previous.pending || previous.status === status) return;
  const operation = beginTaskOperation(taskId, { ...previous, status });
  const startedAtBoard = boardGeneration;
  beginKanbanMutation("カードを移動中");
  try {
    await kanbanApi.updateCard(taskId, { status });
    await refreshKanbanBoard();
  } catch (error) {
    await refreshKanbanBoard();
    if (boardGeneration === startedAtBoard) rollbackStatus(taskId, operation, status, previous.status);
    failKanbanMutation(error);
    finishTaskOperation(taskId, operation);
    return;
  }
  finishTaskOperation(taskId, operation);
  finishKanbanMutation(boardGeneration === startedAtBoard);
}

export async function createTask(title: string): Promise<boolean> {
  const trimmed = title.trim();
  if (!trimmed || !kanbanApi) return false;
  const temporaryId = `pending-${crypto.randomUUID()}`;
  const startedAtBoard = boardGeneration;
  tasks.value = [...tasks.value, { id: temporaryId, title: trimmed, status: "triage", priority: "normal", comments: 0, pending: true }];
  beginKanbanMutation("カードを作成中");
  try {
    const created = await kanbanApi.createCard(trimmed);
    await refreshKanbanBoard();
    if (boardGeneration === startedAtBoard) {
      tasks.value = tasks.value.map((task) => task.id === temporaryId ? { ...created, pending: false } : task);
      notifyProfileTaskCounts();
    }
    finishKanbanMutation(boardGeneration === startedAtBoard);
    return true;
  } catch (error) {
    tasks.value = tasks.value.filter((task) => task.id !== temporaryId);
    failKanbanMutation(error);
    return false;
  }
}

export async function addTaskComment(taskId: string, body: string): Promise<boolean> {
  const trimmed = body.trim();
  if (!trimmed || !kanbanApi) return false;
  const previous = tasks.value.find((task) => task.id === taskId);
  if (!previous || previous.pending) return false;
  const optimisticCount = previous.comments + 1;
  const operation = beginTaskOperation(taskId, { ...previous, comments: optimisticCount });
  const startedAtBoard = boardGeneration;
  beginKanbanMutation("コメントを送信中");
  try {
    await kanbanApi.addComment(taskId, trimmed);
    await refreshKanbanBoard();
  } catch (error) {
    await refreshKanbanBoard();
    if (boardGeneration === startedAtBoard) rollbackCommentCount(taskId, operation, optimisticCount, previous.comments);
    failKanbanMutation(error);
    finishTaskOperation(taskId, operation);
    return false;
  }
  finishTaskOperation(taskId, operation);
  finishKanbanMutation(boardGeneration === startedAtBoard);
  return true;
}

function beginTaskOperation(taskId: string, optimistic: WorkTask): number {
  const operation = ++operationGeneration;
  currentOperations.set(taskId, operation);
  tasks.value = tasks.value.map((task) => task.id === taskId ? { ...optimistic, pending: true } : task);
  return operation;
}

function finishTaskOperation(taskId: string, operation: number): void {
  if (currentOperations.get(taskId) !== operation) return;
  currentOperations.delete(taskId);
  tasks.value = tasks.value.map((task) => task.id === taskId ? { ...task, pending: false } : task);
}

function rollbackAssignee(taskId: string, operation: number, optimistic: string | undefined, previous: string | undefined): void {
  if (currentOperations.get(taskId) !== operation) return;
  tasks.value = tasks.value.map((task) => task.id === taskId && task.assigneeId === optimistic
    ? { ...task, assigneeId: previous }
    : task);
}

function rollbackStatus(taskId: string, operation: number, optimistic: TaskWritableStatus, previous: WorkTask["status"]): void {
  if (currentOperations.get(taskId) !== operation) return;
  tasks.value = tasks.value.map((task) => task.id === taskId && task.status === optimistic ? { ...task, status: previous } : task);
}

function rollbackCommentCount(taskId: string, operation: number, optimistic: number, previous: number): void {
  if (currentOperations.get(taskId) !== operation) return;
  tasks.value = tasks.value.map((task) => task.id === taskId && task.comments === optimistic ? { ...task, comments: previous } : task);
}

function beginKanbanMutation(message: string): void {
  kanbanMutations += 1;
  kanbanState.value = { ...kanbanState.value, state: "saving", message };
}

function finishKanbanMutation(preserveError = false): void {
  kanbanMutations = Math.max(0, kanbanMutations - 1);
  if (preserveError && kanbanMutations === 0) return;
  kanbanState.value = {
    ...kanbanState.value,
    state: kanbanMutations > 0 ? "saving" : "ready",
    message: kanbanMutations > 0 ? "変更を保存中" : `${tasks.value.length}件のカード`
  };
}

function failKanbanMutation(error: unknown): void {
  kanbanMutations = Math.max(0, kanbanMutations - 1);
  setKanbanError(error);
}

function setKanbanError(error: unknown): void {
  kanbanState.value = {
    ...kanbanState.value,
    state: "error",
    message: error instanceof Error ? error.message : "Hermes Kanbanを更新できませんでした"
  };
}

function notifyProfileTaskCounts(): void {
  const counts = new Map<string, number>();
  for (const task of tasks.value) if (task.assigneeId && task.status !== "done" && task.status !== "archived") {
    counts.set(task.assigneeId, (counts.get(task.assigneeId) ?? 0) + 1);
  }
  updateProfileTaskCounts(counts);
}
