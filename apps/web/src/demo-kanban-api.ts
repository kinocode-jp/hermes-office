import type { TaskComment, WorkTask } from "./domain";
import type { KanbanApi, KanbanCardDetailResult } from "./kanban-api";

export function createDemoKanbanApi(
  seedTasks: readonly WorkTask[],
  seedComments: readonly TaskComment[],
  assignees: readonly string[]
): KanbanApi {
  let cards = seedTasks.map(cloneTask);
  let comments = seedComments.map(cloneComment);
  let nextCardId = 1;
  let nextCommentId = Math.max(0, ...comments.map((comment) => comment.id)) + 1;
  let latestEventId = 1;

  const currentCard = (cardId: string): WorkTask => {
    const card = cards.find((item) => item.id === cardId);
    if (!card) throw new Error("Demo card was not found.");
    return { ...card, comments: comments.filter((comment) => comment.cardId === cardId).length };
  };

  return {
    async fetchBoard() {
      return {
        tasks: cards.map((card) => currentCard(card.id)),
        assignees: [...assignees],
        latestEventId
      };
    },
    async fetchCard(cardId): Promise<KanbanCardDetailResult> {
      const cardComments = comments
        .filter((comment) => comment.cardId === cardId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id - right.id)
        .map(cloneComment);
      return {
        card: currentCard(cardId),
        comments: cardComments,
        availableCommentCount: cardComments.length,
        truncated: false
      };
    },
    async createCard(title) {
      let id = `demo-${nextCardId++}`;
      while (cards.some((card) => card.id === id)) id = `demo-${nextCardId++}`;
      const card: WorkTask = { id, title, status: "triage", priority: "normal", comments: 0 };
      cards = [...cards, card];
      latestEventId += 1;
      return cloneTask(card);
    },
    async updateCard(cardId, patch) {
      const current = currentCard(cardId);
      const updated: WorkTask = { ...current };
      if (patch.status !== undefined) updated.status = patch.status;
      if (patch.assignee !== undefined) {
        if (patch.assignee === null) delete updated.assigneeId;
        else updated.assigneeId = patch.assignee;
      }
      cards = cards.map((card) => card.id === cardId ? updated : card);
      latestEventId += 1;
      return cloneTask(updated);
    },
    async addComment(cardId, body) {
      currentCard(cardId);
      comments = [...comments, {
        id: nextCommentId++,
        cardId,
        author: "Demo operator",
        body,
        createdAt: Math.floor(Date.now() / 1_000)
      }];
      cards = cards.map((card) => card.id === cardId ? { ...card, comments: card.comments + 1 } : card);
      latestEventId += 1;
    }
  };
}

function cloneTask(task: WorkTask): WorkTask {
  return { ...task };
}

function cloneComment(comment: TaskComment): TaskComment {
  return { ...comment };
}
