import { useState } from "preact/hooks";
import { chatSessionTitle, t } from "../i18n";
import { profileDisplayName } from "../profile-names";
import {
  deleteSessions,
  openMobileWorkspace,
  openSession,
  profileList,
  sessions,
} from "../store";
import {
  getScheduledKeepCount,
  scheduledKeepCount,
  scheduledKeepCountsByGroup,
  scheduledSessionGroups,
  setScheduledKeepCount,
} from "../scheduled-sessions";
import { TrashIcon } from "./icons";
import { InfoTip } from "./info-tip";

const INITIAL_VISIBLE_SESSIONS = 3;
const VISIBLE_SESSION_STEP = 10;

export function ScheduledSessionsPanel({ hideTitle = false }: { hideTitle?: boolean } = {}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [visibleByGroup, setVisibleByGroup] = useState<Record<string, number>>({});
  const [keepDrafts, setKeepDrafts] = useState<Record<string, string>>({});
  const defaultKeepCount = scheduledKeepCount.value;
  const keepCountsByGroup = scheduledKeepCountsByGroup.value;

  const groups = scheduledSessionGroups(sessions.value);
  const total = groups.reduce((count, group) => count + group.sessions.length, 0);

  const pruneGroup = async (groupKey: string, keepCount: number, pruneCount: number) => {
    if (busyKey || pruneCount === 0) return;
    if (!window.confirm(t("scheduled.pruneGroupConfirm", { keep: keepCount, count: pruneCount }))) return;
    setBusyKey(`prune:${groupKey}`);
    try {
      const group = groups.find((item) => item.key === groupKey);
      const ids = (group?.sessions ?? []).slice(keepCount).map((session) => session.id);
      const result = await deleteSessions(ids);
      if (result.failed.length > 0) {
        window.alert(t("scheduled.deleteFailed", { count: result.failed.length }));
      }
    } finally {
      setBusyKey(null);
    }
  };

  const deleteOne = async (sessionId: string) => {
    if (busyKey) return;
    if (!window.confirm(t("scheduled.deleteOneConfirm"))) return;
    setBusyKey(sessionId);
    try {
      const result = await deleteSessions([sessionId]);
      if (result.failed.length > 0) {
        window.alert(t("scheduled.deleteFailed", { count: result.failed.length }));
      }
    } finally {
      setBusyKey(null);
    }
  };

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((current) => ({ ...current, [groupKey]: !current[groupKey] }));
  };

  const visibleCountFor = (groupKey: string, totalSessions: number) => {
    const requested = visibleByGroup[groupKey] ?? INITIAL_VISIBLE_SESSIONS;
    return Math.min(totalSessions, Math.max(INITIAL_VISIBLE_SESSIONS, requested));
  };

  const showMoreSessions = (groupKey: string, totalSessions: number) => {
    setVisibleByGroup((current) => {
      const currentVisible = current[groupKey] ?? INITIAL_VISIBLE_SESSIONS;
      return {
        ...current,
        [groupKey]: Math.min(totalSessions, currentVisible + VISIBLE_SESSION_STEP),
      };
    });
  };

  const keepDraftFor = (groupKey: string, keepCount: number) => {
    return keepDrafts[groupKey] ?? String(keepCount);
  };

  const commitKeepCount = (groupKey: string, draft: string, fallback: number) => {
    const next = Number(draft);
    if (!Number.isFinite(next)) {
      setKeepDrafts((current) => ({ ...current, [groupKey]: String(fallback) }));
      return;
    }
    setScheduledKeepCount(next, groupKey);
    setKeepDrafts((current) => ({ ...current, [groupKey]: String(getScheduledKeepCount(groupKey)) }));
  };

  return (
    <section
      class="scheduled-sessions-page"
      aria-label={hideTitle ? t("scheduled.title") : undefined}
      aria-labelledby={hideTitle ? undefined : "scheduled-sessions-title"}
    >
      <header class={`page-title-row scheduled-sessions-page-head ${hideTitle ? "is-title-hidden" : ""}`}>
        <div class="heading-info-group">
          {!hideTitle && <h1 id="scheduled-sessions-title">{t("scheduled.title")}</h1>}
          <InfoTip text={`${t("scheduled.subtitle", { count: total })} ${t("scheduled.note")} ${t("scheduled.deleteNote")}`} align="start" side="bottom" />
        </div>
      </header>

      <div class="scheduled-sessions-list">
        {groups.length === 0 ? (
          <p class="scheduled-sessions-empty">{t("scheduled.empty")}</p>
        ) : groups.map((group, groupIndex) => {
          const profile = profileList.value.find((item) => item.id === group.profileId);
          const keepCount = getScheduledKeepCount(group.key, defaultKeepCount);
          void keepCountsByGroup[group.key];
          const pruneCount = Math.max(0, group.sessions.length - keepCount);
          const collapsed = Boolean(collapsedGroups[group.key]);
          const visibleCount = visibleCountFor(group.key, group.sessions.length);
          const visibleSessions = group.sessions.slice(0, visibleCount);
          const remainingCount = Math.max(0, group.sessions.length - visibleCount);
          const nextRevealCount = Math.min(VISIBLE_SESSION_STEP, remainingCount);
          const profileName = profile ? profileDisplayName(profile) : group.profileId;
          const groupDomId = `scheduled-session-group-${groupIndex}`;
          const keepDraft = keepDraftFor(group.key, keepCount);
          return (
            <section class={`scheduled-session-group ${collapsed ? "is-collapsed" : ""}`} key={group.key}>
              <header>
                <button
                  type="button"
                  class="scheduled-session-group-toggle"
                  aria-expanded={!collapsed}
                  aria-controls={groupDomId}
                  aria-label={`${collapsed ? t("scheduled.expandGroup") : t("scheduled.collapseGroup")}: ${group.label} · ${profileName} · ${t("scheduled.sessionCount", { count: group.sessions.length })}`}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span class="scheduled-session-group-caret" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                  <span class="scheduled-session-group-title">
                    <b>{group.label}</b>
                    <small>{profileName}</small>
                    <span class="scheduled-session-group-count">{t("scheduled.sessionCount", { count: group.sessions.length })}</span>
                  </span>
                </button>
                <div class="scheduled-session-group-actions">
                  <label class="scheduled-session-group-keep">
                    <span class="scheduled-session-group-keep-label">{t("scheduled.keepLabelShort")}</span>
                    <input
                      type="number"
                      class="scheduled-keep-input"
                      min={0}
                      max={500}
                      step={1}
                      inputMode="numeric"
                      value={keepDraft}
                      disabled={busyKey !== null}
                      aria-label={t("scheduled.keepLabelForGroup", { label: group.label })}
                      title={t("scheduled.keepLabelForGroup", { label: group.label })}
                      onClick={(event) => event.stopPropagation()}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        setKeepDrafts((current) => ({ ...current, [group.key]: value }));
                      }}
                      onBlur={() => commitKeepCount(group.key, keepDraft, keepCount)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.currentTarget.blur();
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    class="quiet-button scheduled-session-group-prune"
                    disabled={pruneCount === 0 || busyKey !== null}
                    aria-label={busyKey === `prune:${group.key}` ? t("scheduled.deleting") : t("scheduled.pruneGroup", { count: pruneCount, keep: keepCount })}
                    title={busyKey === `prune:${group.key}` ? t("scheduled.deleting") : t("scheduled.pruneGroup", { count: pruneCount, keep: keepCount })}
                    onClick={() => void pruneGroup(group.key, keepCount, pruneCount)}
                  >
                    <span>{busyKey === `prune:${group.key}` ? t("scheduled.deleting") : t("scheduled.pruneGroup", { count: pruneCount })}</span>
                  </button>
                </div>
              </header>
              {!collapsed && (
                <div class="scheduled-session-rows" id={groupDomId}>
                  {visibleSessions.map((session, index) => (
                    <div
                      key={session.id}
                      class={`scheduled-session-row ${session.status === "streaming" ? "is-running" : session.connectionState === "error" || session.errorMessage ? "is-attention" : "is-ready"} ${index >= keepCount ? "is-prunable" : ""}`}
                    >
                      <button
                        type="button"
                        class="scheduled-session-open"
                        aria-label={chatSessionTitle(session)}
                        title={chatSessionTitle(session)}
                        onClick={() => {
                          openSession(session.id);
                          openMobileWorkspace();
                        }}
                      >
                        <i aria-hidden="true" />
                        <span>{chatSessionTitle(session)}</span>
                        <small>
                          {index < keepCount
                            ? t("scheduled.kept")
                            : session.status === "streaming"
                              ? t("profile.running")
                              : session.connectionState === "error" || session.errorMessage
                                ? t("chat.status.error")
                                : t("chat.status.ready")}
                        </small>
                      </button>
                      <button
                        type="button"
                        class="scheduled-session-delete"
                        disabled={busyKey !== null}
                        aria-label={t("scheduled.deleteOne")}
                        title={t("scheduled.deleteOne")}
                        onClick={() => void deleteOne(session.id)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  ))}
                  {remainingCount > 0 && (
                    <button
                      type="button"
                      class="quiet-button scheduled-session-show-more"
                      onClick={() => showMoreSessions(group.key, group.sessions.length)}
                    >
                      {t("scheduled.showMore", { count: nextRevealCount, remaining: remainingCount })}
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
