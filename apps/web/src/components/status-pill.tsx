import type { ProfileStatus } from "../domain";
import { t, type TranslationKey } from "../i18n";

const statusLabel: Record<ProfileStatus, TranslationKey> = {
  working: "status.working",
  waiting: "status.waiting",
  idle: "status.idle",
  blocked: "status.blocked"
};

export function StatusPill({ status }: { status: ProfileStatus }) {
  return <span class={`status-pill status-${status}`}>{t(statusLabel[status])}</span>;
}
