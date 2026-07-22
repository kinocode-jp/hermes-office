import { recurringJobGroups, migrateHiddenRecurringSessionIds, recurringJobRetention, RECURRING_RETENTION_OPTIONS, recurringSessionsToPrune, hideRecurringJobs, hideRecurringSessions, setRecurringJobRetention, isSuccessfulRecurringSession } from "../recurring-jobs";
import { chatSessionTitle, t } from "../i18n";
import { profileDisplayName } from "../profile-names";
import { dismissSessions, closeRecurringJobs, openMobileWorkspace, openSession, profileList, recurringJobsOpen, sessions } from "../store";
import { useMobileOverlay } from "./use-mobile-overlay";

export function RecurringJobsPanel() {
  const open = recurringJobsOpen.value;
  if (open) migrateHiddenRecurringSessionIds(sessions.value);
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open,
    onClose: closeRecurringJobs,
    viewport: "(min-width: 0px)",
  });
  if (!open) return null;
  const groups = recurringJobGroups(sessions.value);
  const pendingCleanup = recurringSessionsToPrune(sessions.value);

  const applyCleanup = () => {
    const ids = recurringSessionsToPrune(sessions.value);
    if (ids.length === 0) return;
    hideRecurringSessions(ids, sessions.value);
    dismissSessions(ids);
  };

  return (
    <div class="recurring-jobs-layer" role="presentation" data-modal-affordance="true" onPointerDown={(event) => { if (event.target === event.currentTarget) closeRecurringJobs(); }}>
      <section
        ref={overlay.ref}
        class="recurring-jobs-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recurring-jobs-title"
        tabIndex={-1}
      >
        <header class="recurring-jobs-head">
          <div>
            <h2 id="recurring-jobs-title">{t("jobs.title")}</h2>
          </div>
          <button type="button" class="icon-button" data-mobile-overlay-initial-focus aria-label={t("jobs.close")} onClick={closeRecurringJobs}>×</button>
        </header>

        <section class="recurring-jobs-settings" aria-label={t("jobs.retention")}>
          <label>
            <span>{t("jobs.retention")}</span>
            <select value={String(recurringJobRetention.value)} onChange={(event) => setRecurringJobRetention(Number(event.currentTarget.value))}>
              {RECURRING_RETENTION_OPTIONS.map((value) => <option key={value} value={value}>{value === 0 ? t("jobs.unlimited") : t("jobs.retentionCount", { count: value })}</option>)}
            </select>
          </label>
          <button type="button" class="quiet-button recurring-jobs-cleanup" disabled={pendingCleanup.length === 0} onClick={applyCleanup}>
            {t("jobs.apply", { count: pendingCleanup.length })}
          </button>
        </section>

        <div class="recurring-jobs-list">
          {groups.length === 0 ? <p class="recurring-jobs-empty">{t("jobs.empty")}</p> : groups.map((group) => {
            const profile = profileList.value.find((item) => item.id === group.profileId);
            const healthyCount = group.sessions.filter(isSuccessfulRecurringSession).length;
            return (
              <section class="recurring-job-group" key={group.key}>
                <header>
                  <div><b>{group.label}</b><small>{profile ? profileDisplayName(profile) : group.profileId}</small></div>
                  <span>{t("jobs.sessionCount", { count: group.sessions.length })}</span>
                  <button
                    type="button"
                    class="quiet-button"
                    onClick={() => {
                      hideRecurringJobs([group.key]);
                      dismissSessions(group.sessions.map((session) => session.id));
                    }}
                  >{t("jobs.hideGroup")}</button>
                </header>
                <p class="recurring-job-health">{t("jobs.healthy", { count: healthyCount })}</p>
                <div class="recurring-job-sessions">
                  {group.sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      class={`recurring-job-session ${isSuccessfulRecurringSession(session) ? "is-healthy" : "is-attention"}`}
                      onClick={() => { openSession(session.id); openMobileWorkspace(); closeRecurringJobs(); }}
                    >
                      <i aria-hidden="true" />
                      <span>{chatSessionTitle(session)}</span>
                      <small>{session.status === "streaming" ? t("profile.running") : isSuccessfulRecurringSession(session) ? "OK" : t("chat.status.error")}</small>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}
