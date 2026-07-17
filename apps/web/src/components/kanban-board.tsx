import type { TaskStatus, TaskWritableStatus, WorkTask } from "../domain";
import { locale, localizeRuntimeMessage, t, type TranslationKey } from "../i18n";
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
  retryTaskComments,
  taskCommentDetail,
  tasks,
  toggleTaskComments
} from "../store";
import {
  allowUnconfirmedCommentResend,
  allowUnconfirmedTaskResend,
  confirmUnconfirmedComment,
  confirmUnconfirmedTaskCreation,
  taskCreationBusy,
  unconfirmedTaskComments,
  unconfirmedTaskCreation
} from "../kanban-store";

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
const writableColumns = columns.filter((column): column is typeof column & { writable: TaskWritableStatus } => Boolean(column.writable));
const writableStatuses = new Set<TaskStatus>(writableColumns.map((column) => column.writable));

export function requestTaskMove(taskId: string, value: string): Promise<void> {
  const status = writableColumns.find((column) => column.writable === value)?.writable;
  return status ? moveTask(taskId, status) : Promise.resolve();
}

function TaskCard({ task }: { task: WorkTask }) {
  const assignee = profileList.value.find((profile) => profile.id === task.assigneeId);
  const selectableProfiles = kanbanAssignees.value.length === 0
    ? profileList.value
    : profileList.value.filter((profile) => kanbanAssignees.value.includes(profile.id));
  const expanded = expandedTaskId.value === task.id;
  const detail = taskCommentDetail.value.cardId === task.id ? taskCommentDetail.value : undefined;
  const unconfirmedComment = unconfirmedTaskComments.value[task.id];

  const submitComment = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("comment") as HTMLInputElement;
    if (await addTaskComment(task.id, input.value) === "success") form.reset();
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

      <label class="task-status-select">
        <span>{t("kanban.status")}</span>
        <select
          value={writableStatuses.has(task.status) ? task.status : ""}
          disabled={task.pending}
          onChange={(event) => void requestTaskMove(task.id, event.currentTarget.value)}
        >
          {!writableStatuses.has(task.status) && <option value="" disabled>{t("kanban.managedStatus")}</option>}
          {writableColumns.map((column) => <option key={column.id} value={column.writable}>{t(column.label)}</option>)}
        </select>
        <small>{t("kanban.managedStatusHint")}</small>
      </label>

      <footer>
        <span class="task-assignee">
          {assignee ? <i style={{ background: assignee.color }} /> : <i class="unassigned" />}
          {assignee?.name ?? t("kanban.unassigned")}
        </span>
        <button type="button" aria-expanded={expanded} onClick={() => void toggleTaskComments(task.id)}>
          {t("kanban.notes", { count: task.comments })}
        </button>
      </footer>

      {expanded && (
        <section class="task-comments" aria-label={t("kanban.commentsAria", { title: task.title })}>
          {detail?.state === "loading" && <p class="task-comments-state" role="status">{t("kanban.commentsLoading")}</p>}
          {detail?.state === "error" && (
            <div class="task-comments-error" role="alert">
              <span>{t("kanban.commentsError")}</span>
              <button type="button" onClick={() => void retryTaskComments()}>{t("kanban.commentsRetry")}</button>
            </div>
          )}
          {detail && detail.comments.length > 0 && (
            <ol class="task-comment-list">
              {detail.comments.map((comment) => (
                <li key={comment.id}>
                  <header><strong>{comment.author}</strong><time dateTime={commentDate(comment.createdAt).toISOString()}>{formatCommentTime(comment.createdAt)}</time></header>
                  <p>{comment.body}</p>
                </li>
              ))}
            </ol>
          )}
          {detail?.state === "ready" && detail.comments.length === 0 && <p class="task-comments-empty">{t("kanban.commentsEmpty")}</p>}
          {detail?.truncated && <p class="task-comments-limit">{t("kanban.commentsLimited", { shown: detail.comments.length, count: detail.availableCommentCount })}</p>}
          <form class="task-comment-form" onSubmit={submitComment}>
            <input name="comment" aria-label={t("kanban.commentAria", { title: task.title })} placeholder={t("kanban.commentPlaceholder")} maxLength={16000} required />
            <button type="submit" disabled={task.pending || Boolean(unconfirmedComment)}>{t("chat.send")}</button>
          </form>
          {unconfirmedComment && (
            <UnconfirmedSubmissionNotice
              detail={t("kanban.unknown.comment")}
              checked={unconfirmedComment.checked}
              checking={unconfirmedComment.checking}
              onCheck={() => void confirmUnconfirmedComment(task.id)}
              onAllow={() => allowUnconfirmedCommentResend(task.id)}
            />
          )}
        </section>
      )}
    </article>
  );
}

function UnconfirmedSubmissionNotice({
  detail,
  checked,
  checking,
  onCheck,
  onAllow
}: {
  detail: string;
  checked: boolean;
  checking: boolean;
  onCheck(): void;
  onAllow(): void;
}) {
  return (
    <section class="kanban-unconfirmed" role="alert">
      <strong>{t("kanban.unknown.title")}</strong>
      <p>{checked ? t("kanban.unknown.checked") : detail}</p>
      {checked
        ? <button type="button" onClick={onAllow}>{t("kanban.unknown.retry")}</button>
        : <button type="button" disabled={checking} onClick={onCheck}>{t("kanban.unknown.check")}</button>}
    </section>
  );
}

export function KanbanBoard() {
  const submitTask = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("task-title") as HTMLInputElement;
    if (await createTask(input.value) === "success") form.reset();
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
          <button type="button" onClick={() => void refreshKanbanBoard({ acknowledgeErrors: true })} disabled={boardState.state === "loading"}>{t("kanban.reload")}</button>
        </div>
        <form class="task-create" onSubmit={submitTask}>
          <input name="task-title" aria-label={t("kanban.newTask")} placeholder={t("kanban.newTaskPlaceholder")} maxLength={240} required disabled={taskCreationBusy.value || Boolean(unconfirmedTaskCreation.value)} />
          <button class="primary-button" type="submit" disabled={boardState.state === "loading" || taskCreationBusy.value || Boolean(unconfirmedTaskCreation.value)}>{t("kanban.add")}</button>
        </form>
        {unconfirmedTaskCreation.value && (
          <UnconfirmedSubmissionNotice
            detail={t("kanban.unknown.task")}
            checked={unconfirmedTaskCreation.value.checked}
            checking={unconfirmedTaskCreation.value.checking}
            onCheck={() => void confirmUnconfirmedTaskCreation()}
            onAllow={allowUnconfirmedTaskResend}
          />
        )}
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
                if (taskId && column.writable) void requestTaskMove(taskId, column.writable);
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

function commentDate(createdAt: number): Date {
  return new Date(createdAt * 1_000);
}

function formatCommentTime(createdAt: number): string {
  return new Intl.DateTimeFormat(locale.value === "ja" ? "ja-JP" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(commentDate(createdAt));
}
