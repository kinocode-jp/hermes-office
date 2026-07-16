import type { TaskStatus, TaskWritableStatus, WorkTask } from "../domain";
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

const columns: Array<{ id: TaskStatus; label: string; caption: string; writable?: TaskWritableStatus }> = [
  { id: "triage", label: "Triage", caption: "整理前", writable: "triage" },
  { id: "todo", label: "Todo", caption: "計画済み", writable: "todo" },
  { id: "scheduled", label: "Scheduled", caption: "予約済み", writable: "scheduled" },
  { id: "ready", label: "Ready", caption: "着手可能", writable: "ready" },
  { id: "running", label: "Running", caption: "Hermes実行中" },
  { id: "blocked", label: "Blocked", caption: "要確認", writable: "blocked" },
  { id: "review", label: "Review", caption: "レビュー中" },
  { id: "done", label: "Done", caption: "完了", writable: "done" }
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
        {task.pending && <span class="task-saving">SAVING</span>}
      </div>
      <h3>{task.title}</h3>
      {(task.latestSummary || task.body) && <p class="task-summary">{task.latestSummary ?? task.body}</p>}

      <label class="task-assignee-select">
        <span>担当</span>
        <select
          value={task.assigneeId ?? ""}
          disabled={task.pending}
          onChange={(event) => void assignTask(task.id, event.currentTarget.value || null)}
        >
          <option value="">未割当</option>
          {selectableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>

      <footer>
        <span class="task-assignee">
          {assignee ? <i style={{ background: assignee.color }} /> : <i class="unassigned" />}
          {assignee?.name ?? "未割当"}
        </span>
        <button type="button" onClick={() => { expandedTaskId.value = expanded ? "" : task.id; }}>
          {task.comments} notes
        </button>
      </footer>

      {expanded && (
        <form class="task-comment-form" onSubmit={submitComment}>
          <input name="comment" aria-label={`${task.title}へのコメント`} placeholder="コメントを追加…" maxLength={16000} required />
          <button type="submit" disabled={task.pending}>送信</button>
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
          <p class="eyebrow">Live shared Hermes board</p>
          <h1>仕事ボード</h1>
        </div>
        <div class={`kanban-sync state-${boardState.state}`} role={boardState.state === "error" ? "alert" : "status"}>
          <span>{boardState.message}</span>
          <button type="button" onClick={() => void refreshKanbanBoard()} disabled={boardState.state === "loading"}>再読込</button>
        </div>
        <form class="task-create" onSubmit={submitTask}>
          <input name="task-title" aria-label="新しい仕事" placeholder="新しい仕事…" maxLength={240} required />
          <button class="primary-button" type="submit" disabled={boardState.state === "loading"}>＋ 追加</button>
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
                  <b>{column.label}</b>
                  <span>{column.caption}{!column.writable && " · 自動"}</span>
                </div>
                <strong>{items.length}</strong>
              </header>
              <div class="task-stack">
                {items.map((task) => <TaskCard key={task.id} task={task} />)}
                {items.length === 0 && <p class="column-empty">カードはありません</p>}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
