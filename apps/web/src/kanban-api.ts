import type { TaskStatus, TaskWritableStatus, WorkTask } from "./domain";
import { officeFetchJson } from "./office-api";

export type KanbanBoardResult = {
  tasks: WorkTask[];
  assignees: string[];
  latestEventId: number;
};

export type KanbanApi = {
  fetchBoard(): Promise<KanbanBoardResult>;
  createCard(title: string): Promise<WorkTask>;
  updateCard(cardId: string, patch: { status?: TaskWritableStatus; assignee?: string | null }): Promise<WorkTask>;
  addComment(cardId: string, body: string): Promise<void>;
};

const READ_STATUSES = new Set<TaskStatus>([
  "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"
]);

export function createKanbanApi(): KanbanApi {
  return {
    async fetchBoard() {
      const value = await officeFetchJson<unknown>("/api/v1/kanban", { timeoutMs: 8_000 });
      return normalizeBoard(value);
    },
    async createCard(title) {
      const value = await officeFetchJson<unknown>("/api/v1/kanban/cards", {
        method: "POST",
        body: { title, triage: true },
        timeoutMs: 8_000
      });
      return normalizeCardResult(value);
    },
    async updateCard(cardId, patch) {
      const value = await officeFetchJson<unknown>(`/api/v1/kanban/cards/${encodeURIComponent(cardId)}`, {
        method: "PATCH",
        body: patch,
        timeoutMs: 8_000
      });
      return normalizeCardResult(value);
    },
    async addComment(cardId, body) {
      await officeFetchJson<unknown>(`/api/v1/kanban/cards/${encodeURIComponent(cardId)}/comments`, {
        method: "POST",
        body: { body },
        timeoutMs: 8_000
      });
    }
  };
}

function normalizeBoard(value: unknown): KanbanBoardResult {
  const board = record(value, "Kanban board");
  if (!Array.isArray(board.columns)) throw new Error("Kanban board columns are invalid.");
  const tasks = board.columns.flatMap((entry): WorkTask[] => {
    const column = record(entry, "Kanban column");
    const status = taskStatus(column.status);
    if (!Array.isArray(column.cards)) throw new Error("Kanban cards are invalid.");
    return column.cards.map((card) => normalizeCard(card, status));
  });
  const assignees = Array.isArray(board.assignees)
    ? board.assignees.filter((value): value is string => typeof value === "string")
    : [];
  return {
    tasks,
    assignees,
    latestEventId: finiteNumber(board.latestEventId) ?? 0
  };
}

function normalizeCardResult(value: unknown): WorkTask {
  const result = record(value, "Kanban mutation result");
  return normalizeCard(result.card ?? value);
}

function normalizeCard(value: unknown, fallbackStatus?: TaskStatus): WorkTask {
  const card = record(value, "Kanban card");
  if (typeof card.id !== "string" || typeof card.title !== "string") {
    throw new Error("Kanban card identity is invalid.");
  }
  const status = card.status === undefined && fallbackStatus ? fallbackStatus : taskStatus(card.status);
  const priorityValue = finiteNumber(card.priority) ?? 0;
  const body = typeof card.body === "string" ? card.body : undefined;
  const assigneeId = typeof card.assignee === "string" ? card.assignee : undefined;
  const latestSummary = typeof card.latestSummary === "string" ? card.latestSummary : undefined;
  return {
    id: card.id,
    title: card.title,
    status,
    priority: priorityValue > 0 ? "high" : "normal",
    priorityValue,
    comments: finiteNumber(card.commentCount) ?? 0,
    ...(body ? { body } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(latestSummary ? { latestSummary } : {})
  };
}

function taskStatus(value: unknown): TaskStatus {
  if (typeof value !== "string" || !READ_STATUSES.has(value as TaskStatus)) {
    throw new Error("Kanban card status is invalid.");
  }
  return value as TaskStatus;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
