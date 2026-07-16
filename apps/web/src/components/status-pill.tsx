import type { ProfileStatus } from "../domain";
import { t, type TranslationKey } from "../i18n";

const statusLabel: Record<ProfileStatus, TranslationKey> = {
  working: "status.working",
  waiting: "status.waiting",
  idle: "status.idle",
  blocked: "status.blocked"
};

/** Icon-only status light. The label is exposed via tooltip and screen readers. */
export function StatusPill({ status }: { status: ProfileStatus }) {
  const label = t(statusLabel[status]);
  return <span class={`status-pill status-${status}`} role="img" aria-label={label} title={label} />;
}
