import type { Profile } from "../domain";
import { assignTask, selectProfile, selectedProfileId, tasks } from "../store";
import { StatusPill } from "./status-pill";
import { TaskCables, type TaskCable } from "./task-cables";

const standardDeskPorts = [
  { x: 180, y: 155 },
  { x: 720, y: 140 },
  { x: 270, y: 365 },
  { x: 740, y: 365 }
];

function ProfilePod({ profile, index, crowded, columnCount, rowCount }: { profile: Profile; index: number; crowded: boolean; columnCount: number; rowCount: number }) {
  const selected = selectedProfileId.value === profile.id;
  const column = index % columnCount;
  const row = Math.floor(index / columnCount);

  return (
    <button
      class={`profile-pod pod-${index + 1} ${selected ? "is-selected" : ""}`}
      style={{
        "--agent-color": profile.color,
        ...(crowded ? {
          left: `${2 + column * (96 / columnCount)}%`,
          top: `${14 + row * (48 / Math.max(1, rowCount - 1))}%`,
          "--pod-scale": Math.min(0.82, 1.64 / rowCount)
        } : {})
      }}
      onClick={() => selectProfile(profile.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const taskId = event.dataTransfer?.getData("application/x-hermes-task");
        if (taskId) assignTask(taskId, profile.id);
      }}
      aria-label={`${profile.name}、${profile.role}、${profile.sessions}件の会話`}
    >
      <span class="desk-lamp" aria-hidden="true" />
      <span class="desk">
        <span class="monitor">
          <span class="monitor-lines" />
        </span>
        <span class="desk-edge" />
      </span>
      <span class="agent">
        <span class="agent-head" />
        <span class="agent-body" />
      </span>
      <span class="pod-label">
        <span class="pod-name">{profile.name}</span>
        <span class="pod-role">{profile.role}</span>
      </span>
      <span class="pod-meta">
        <StatusPill status={profile.status} />
        <span>{profile.sessions} chats</span>
      </span>
    </button>
  );
}

export function OfficeScene({ profiles }: { profiles: Profile[] }) {
  // Keep a maximum of two desk rows for the usual profile counts. The former
  // fixed five-column layout wrapped profile 11 onto profile 1, making only the
  // last overlapping character clickable.
  const columnCount = Math.max(1, Math.min(6, Math.ceil(profiles.length / 2)));
  const rowCount = Math.max(1, Math.ceil(profiles.length / columnCount));
  const working = profiles.filter((profile) => profile.status === "working").length;
  const attention = profiles.filter((profile) => profile.status === "waiting" || profile.status === "blocked").length;
  const cables: TaskCable[] = tasks.value.flatMap((task, index) => {
    if (!task.assigneeId) return [];
    const profileIndex = profiles.findIndex((item) => item.id === task.assigneeId);
    if (profileIndex < 0) return [];
    const profile = profiles[profileIndex]!;
    const target = deskPort(profileIndex, profiles.length, columnCount, rowCount);
    return [{
      id: `cable-${task.id}`,
      taskId: task.id,
      taskLabel: task.title,
      profileId: profile.id,
      profileName: profile.name,
      source: { x: 500 + index * 5, y: 250 },
      target,
      state: task.status === "running" ? "active" : task.status === "blocked" ? "blocked" : "queued",
      pulse: task.status === "running"
    }];
  });

  return (
    <section class="office-wrap" aria-labelledby="office-title">
      <header class="office-heading">
        <div>
          <p class="eyebrow">Live floor · local runtime</p>
          <h1 id="office-title">今日のオフィス</h1>
        </div>
        <div class="shift-readout" aria-label="オフィス稼働状況">
          <span><b>{working}</b> 稼働</span>
          <span><b>{attention}</b> 要確認</span>
          <span><b>{profiles.length}</b> Profiles</span>
        </div>
      </header>

      <div class={`office-floor ${profiles.length > 4 ? "is-crowded" : ""}`}>
        <div class="window-wall" aria-hidden="true">
          <span /><span /><span /><span />
        </div>
        <div class="floor-grid" aria-hidden="true" />
        <div class="meeting-table" aria-hidden="true">
          <span>BOARD</span>
        </div>
        <TaskCables
          cables={cables}
          width={1000}
          height={500}
          maxCables={24}
          onSelect={(cable) => selectProfile(cable.profileId)}
        />
        <div class="library-shelf" aria-hidden="true">
          <i /><i /><i /><i /><i /><i />
        </div>
        {profiles.map((profile, index) => <ProfilePod key={profile.id} profile={profile} index={index} crowded={profiles.length > 4} columnCount={columnCount} rowCount={rowCount} />)}
        <div class="office-legend">
          <span><i class="legend-light working" />working</span>
          <span><i class="legend-light waiting" />needs you</span>
          <span>カードを社員へドロップして担当変更</span>
        </div>
      </div>
    </section>
  );
}

function deskPort(index: number, profileCount: number, columnCount: number, rowCount: number): { x: number; y: number } {
  if (profileCount <= standardDeskPorts.length) return standardDeskPorts[index] ?? { x: 500, y: 250 };
  const column = index % columnCount;
  const row = Math.floor(index / columnCount);
  const leftPercent = 2 + column * (96 / columnCount);
  const topPercent = 14 + row * (48 / Math.max(1, rowCount - 1));
  return { x: leftPercent * 10 + 65, y: topPercent * 5 + 45 };
}
