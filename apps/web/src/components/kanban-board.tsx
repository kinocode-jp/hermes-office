import type { TaskStatus, TaskWritableStatus, WorkTask } from "../domain";
import { localizeRuntimeMessage, t, type TranslationKey } from "../i18n";
import {
  addTaskComment,
  assignTask,
  createTask,
  expandedTaskId,
  kanbanAssignees,
  kanbanState,
  moveTask,
  profileList,
  refreshKanbanBoard,
  tasks
} from "../store";

const columns: Array<{ id: TaskStatus; label: TranslationKey; caption: TranslationKey; writable?: TaskWritableStatus }> = [
  { id: "triage", label: "kanban.column.triage", caption: "kanban.caption.triage", writable: "triage" },
  { id: "todo", label: "kanban.column.todo", caption: "kanban.caption.todo", writable: "todo" },
  { id: "scheduled", label: "kanban.column.scheduled", caption: "kanban.caption.scheduled", writable: "scheduled" },
  { id: "ready", label: "kanban.column.ready", caption: "kanban.caption.ready", writable: "ready" },
  { id: "running", label: "kanban.column.running", caption: "kanban.caption.running" },
  { id: "blocked", label: "kanban.column.blocked", caption: "kanban.caption.blocked", writable: "blocked" },
  { id: "review", label: "kanban.column.review", caption: "kanban.caption.review" },
  { id: "done", label: "kanban.column.done", caption: "kanban.caption.done", writable: "done" }
];

function TaskCard({ task }: { task: WorkTask }) {
  const assignee = profileList.value.find((profile) => profile.id === task.assigneeId);
  const selectableProfiles = kanbanAssignees.value.length === 0
    ? profileList.value
    : profileList.value.filter((profile) => kanbanAssignees.value.includes(profile.id));
  const expanded = expandedTaskId.value === task.id;

  const submitComment = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("comment") as HTMLInputElement;
    if (await addTaskComment(task.id, input.value)) form.reset();
  };

  return (
    <article
      class={`task-card priority-${task.priority} ${task.pending ? "is-pending" : ""}`}
      draggable={!task.pending}
      onDragStart={(event) => event.dataTransfer?.setData("application/x-hermes-task", task.id)}
    >
      <div class="task-card-topline">
        <span class="task-id">{task.id}</span>
        {task.pending && <span class="task-saving">{t("kanban.saving")}</span>}
      </div>
      <h3>{task.title}</h3>
      {(task.latestSummary || task.body) && <p class="task-summary">{task.latestSummary ?? task.body}</p>}

      <label class="task-assignee-select">
        <span>{t("kanban.assignee")}</span>
        <select
          value={task.assigneeId ?? ""}
          disabled={task.pending}
          onChange={(event) => void assignTask(task.id, event.currentTarget.value || null)}
        >
          <option value="">{t("kanban.unassigned")}</option>
          {selectableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>

      <footer>
        <span class="task-assignee">
          {assignee ? <i style={{ background: assignee.color }} /> : <i class="unassigned" />}
          {assignee?.name ?? t("kanban.unassigned")}
        </span>
        <button type="button" onClick={() => { expandedTaskId.value = expanded ? "" : task.id; }}>
          {t("kanban.notes", { count: task.comments })}
        </button>
      </footer>

      {expanded && (
        <form class="task-comment-form" onSubmit={submitComment}>
          <input name="comment" aria-label={t("kanban.commentAria", { title: task.title })} placeholder={t("kanban.commentPlaceholder")} maxLength={16000} required />
          <button type="submit" disabled={task.pending}>{t("chat.send")}</button>
        </form>
      )}
    </article>
  );
}

export function KanbanBoard() {
  const submitTask = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("task-title") as HTMLInputElement;
    if (await createTask(input.value)) form.reset();
  };
  const boardState = kanbanState.value;

  return (
    <section class="kanban-page">
      <header class="page-title-row">
        <div>
          <p class="eyebrow">{t("kanban.eyebrow")}</p>
          <h1>{t("kanban.title")}</h1>
        </div>
        <div class={`kanban-sync state-${boardState.state}`} role={boardState.state === "error" ? "alert" : "status"}>
          <span>{localizeRuntimeMessage(boardState.message)}</span>
          <button type="button" onClick={() => void refreshKanbanBoard()} disabled={boardState.state === "loading"}>{t("kanban.reload")}</button>
        </div>
        <form class="task-create" onSubmit={submitTask}>
          <input name="task-title" aria-label={t("kanban.newTask")} placeholder={t("kanban.newTaskPlaceholder")} maxLength={240} required />
          <button class="primary-button" type="submit" disabled={boardState.state === "loading"}>{t("kanban.add")}</button>
        </form>
      </header>

      <div class="kanban-board">
        {columns.map((column) => {
          const items = tasks.value.filter((task) => task.status === column.id);
          return (
            <section
              class={`kanban-column column-${column.id} ${column.writable ? "is-writable" : "is-managed"}`}
              key={column.id}
              onDragOver={(event) => { if (column.writable) event.preventDefault(); }}
              onDrop={(event) => {
                const taskId = event.dataTransfer?.getData("application/x-hermes-task");
                if (taskId && column.writable) void moveTask(taskId, column.writable);
              }}
            >
              <header>
                <div>
                  <b>{t(column.label)}</b>
                  <span>{t(column.caption)}{!column.writable && ` · ${t("kanban.automatic")}`}</span>
                </div>
                <strong>{items.length}</strong>
              </header>
              <div class="task-stack">
                {items.map((task) => <TaskCard key={task.id} task={task} />)}
                {items.length === 0 && <p class="column-empty">{t("kanban.empty")}</p>}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
