import { signal } from "@preact/signals";
import type { TaskComment } from "./domain";
import type { KanbanApi } from "./kanban-api";

export type TaskCommentDetailState = {
  cardId: string;
  state: "idle" | "loading" | "ready" | "error";
  comments: TaskComment[];
  availableCommentCount: number;
  truncated: boolean;
  message: string;
};

const idleState = (): TaskCommentDetailState => ({
  cardId: "",
  state: "idle",
  comments: [],
  availableCommentCount: 0,
  truncated: false,
  message: ""
});

export function createTaskCommentController(getApi: () => KanbanApi | undefined) {
  const expandedTaskId = signal("");
  const taskCommentDetail = signal<TaskCommentDetailState>(idleState());
  let loadGeneration = 0;

  async function toggle(taskId: string): Promise<void> {
    if (expandedTaskId.value === taskId) {
      collapse();
      return;
    }
    expandedTaskId.value = taskId;
    await load(taskId, false);
  }

  function collapse(): void {
    loadGeneration += 1;
    expandedTaskId.value = "";
    taskCommentDetail.value = idleState();
  }

  async function retry(): Promise<void> {
    const cardId = expandedTaskId.value;
    if (cardId) await load(cardId, true);
  }

  async function refreshIfExpanded(cardId?: string): Promise<void> {
    const expanded = expandedTaskId.value;
    if (!expanded || (cardId !== undefined && expanded !== cardId)) return;
    await load(expanded, true);
  }

  async function load(cardId: string, preserveComments: boolean): Promise<void> {
    const api = getApi();
    if (!api || expandedTaskId.value !== cardId) return;
    const generation = ++loadGeneration;
    const previous = taskCommentDetail.value.cardId === cardId ? taskCommentDetail.value : idleState();
    taskCommentDetail.value = {
      cardId,
      state: "loading",
      comments: preserveComments ? previous.comments : [],
      availableCommentCount: preserveComments ? previous.availableCommentCount : 0,
      truncated: preserveComments && previous.truncated,
      message: ""
    };
    try {
      const detail = await api.fetchCard(cardId);
      if (generation !== loadGeneration || expandedTaskId.value !== cardId) return;
      taskCommentDetail.value = {
        cardId,
        state: "ready",
        comments: detail.comments,
        availableCommentCount: detail.availableCommentCount,
        truncated: detail.truncated,
        message: ""
      };
    } catch (error) {
      if (generation !== loadGeneration || expandedTaskId.value !== cardId) return;
      taskCommentDetail.value = {
        ...taskCommentDetail.value,
        cardId,
        state: "error",
        message: error instanceof Error ? error.message : "Kanban comments are unavailable."
      };
    }
  }

  return { expandedTaskId, taskCommentDetail, toggle, collapse, retry, refreshIfExpanded };
}
