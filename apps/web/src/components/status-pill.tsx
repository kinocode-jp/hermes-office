import type { ProfileStatus } from "../domain";

const statusLabel: Record<ProfileStatus, string> = {
  working: "作業中",
  waiting: "確認待ち",
  idle: "待機",
  blocked: "停止中"
};

export function StatusPill({ status }: { status: ProfileStatus }) {
  return <span class={`status-pill status-${status}`}>{statusLabel[status]}</span>;
}
