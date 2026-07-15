import type { TaskStatus, WorkTask } from "../domain";
import { createTask, moveTask, profileList, tasks } from "../store";

const columns: { id: TaskStatus; label: string; caption: string }[] = [
  { id: "triage", label: "Triage", caption: "整理前" },
  { id: "ready", label: "Ready", caption: "着手可能" },
  { id: "running", label: "Running", caption: "実行中" },
  { id: "blocked", label: "Blocked", caption: "要確認" },
  { id: "done", label: "Done", caption: "完了" }
];

function TaskCard({ task }: { task: WorkTask }) {
  const assignee = profileList.value.find((profile) => profile.id === task.assigneeId);
  return (
    <article
      class={`task-card priority-${task.priority}`}
      draggable
      onDragStart={(event) => event.dataTransfer?.setData("application/x-hermes-task", task.id)}
    >
      <div class="task-id">{task.id}</div>
      <h3>{task.title}</h3>
      <footer>
        <span class="task-assignee">
          {assignee ? <i style={{ background: assignee.color }} /> : <i class="unassigned" />}
          {assignee?.name ?? "未割当"}
        </span>
        <span>{task.comments} notes</span>
      </footer>
    </article>
  );
}

export function KanbanBoard() {
  const submitTask = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("task-title") as HTMLInputElement;
    createTask(input.value);
    form.reset();
  };
  return (
    <section class="kanban-page">
      <header class="page-title-row">
        <div>
          <p class="eyebrow">Shared Hermes board</p>
          <h1>仕事ボード</h1>
        </div>
        <form class="task-create" onSubmit={submitTask}>
          <input name="task-title" aria-label="新しい仕事" placeholder="新しい仕事…" required />
          <button class="primary-button" type="submit">＋ 追加</button>
        </form>
      </header>
      <div class="kanban-board">
        {columns.map((column) => {
          const items = tasks.value.filter((task) => task.status === column.id);
          return (
            <section
              class={`kanban-column column-${column.id}`}
              key={column.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const taskId = event.dataTransfer?.getData("application/x-hermes-task");
                if (taskId) moveTask(taskId, column.id);
              }}
            >
              <header>
                <div><b>{column.label}</b><span>{column.caption}</span></div>
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
