import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { Surface, Profile } from "../domain";
import { chatSessionTitle, t, type TranslationKey } from "../i18n";
import { loadMoreProfiles, profileInventoryState } from "../inventory";
import { tasks } from "../kanban-store";
import { profileDisplayName, profileDisplayNameMap, profileSecondaryName } from "../profile-names";
import {
  activeSessionId,
  activeSurface,
  navigateToSurface,
  openMobileWorkspace,
  openRecurringJobs,
  openSession,
  openSessionIds,
  profileList,
  selectProfile,
  selectedProfileId,
  sessions,
} from "../store";
import {
  SIDEBAR_ICON_THRESHOLD,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  isSidebarIconOnly,
  isSidebarProfileOpen,
  setSidebarProfilesOpen,
  setSidebarMode,
  setSidebarWidth,
  previewSidebarWidth,
  sidebarMode,
  sidebarProfilesOpen,
  sidebarWidth,
  toggleSidebarProfileOpen,
} from "../sidebar-layout";
import { CharacterPortrait } from "./character-portrait";
import { CardsIcon, ClockIcon, GroupIcon, ListIcon, UsersIcon } from "./icons";
import { StatusPill } from "./status-pill";
import { TeamBadges } from "./team-badges";
import { migrateHiddenRecurringSessionIds, recurringJobGroups } from "../recurring-jobs";
import { teams } from "../teams-store";
import { groupProfilesByTeams, profileGroupItemKey, type ProfileTeamGroup } from "../profile-team-groups";
import { setSidebarGroupMode, sidebarGroupMode } from "../group-display-prefs";
import { ProfileContextMenu, useProfileContextMenu } from "./profile-context-menu";
import { isPhoneViewport } from "../viewport";


function sidebarTaskStatusLabel(status: string): string {
  switch (status) {
    case "triage": return t("kanban.column.triage");
    case "todo": return t("kanban.column.todo");
    case "scheduled": return t("kanban.column.scheduled");
    case "ready": return t("kanban.column.ready");
    case "running": return t("kanban.column.running");
    case "blocked": return t("kanban.column.blocked");
    case "review": return t("kanban.column.review");
    case "done": return t("kanban.column.done");
    default: return status;
  }
}

function sidebarTaskAssigneeName(assigneeId: string, profiles: readonly Profile[]): string {
  const profile = profiles.find((item) => item.id === assigneeId);
  return profile ? profileDisplayName(profile) : assigneeId;
}

export type SideRailNavItem = { id: Surface; icon: ComponentType; label: TranslationKey };

type SideRailProps = {
  navItems: readonly SideRailNavItem[];
};

export function SideRail({ navItems }: SideRailProps) {
  const resizePointerId = useRef<number | null>(null);
  const {
    menu,
    menuRef,
    closeMenu,
    openProfileMenu,
    openSessionMenu,
    openMenuSession,
  } = useProfileContextMenu();
  const inventory = profileInventoryState.value;
  const iconOnly = isSidebarIconOnly();
  const [phoneViewport, setPhoneViewport] = useState(isPhoneViewport());

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 767px)");
    const sync = () => setPhoneViewport(query.matches);
    sync();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", sync);
      return () => query.removeEventListener("change", sync);
    }
    query.addListener(sync);
    return () => query.removeListener(sync);
  }, []);

  void profileDisplayNameMap();
  const hasTeams = teams.value.length > 0;
  const groupMode = hasTeams && sidebarGroupMode.value === "teams" ? "teams" : "profiles";
  const grouping = groupMode === "teams"
    ? groupProfilesByTeams(profileList.value, teams.value)
    : { mode: "flat" as const, profiles: profileList.value };

  const copy = {
    profiles: t("sidebar.profiles"),
    displayMode: t(sidebarMode.value === "rows" ? "sidebar.mode.cards" : "sidebar.mode.rows"),
    profileToggle: t(sidebarProfilesOpen.value ? "sidebar.profilesClose" : "sidebar.profilesOpen"),
    profileExpand: t("sidebar.sessionsShow"),
    profileCollapse: t("sidebar.sessionsHide"),
    resize: t("sidebar.resize"),
    resizeTitle: t("sidebar.resizeTitle"),
    profileCount: t("sidebar.profileCount", { count: profileList.value.length }),
    sessionCount: (count: number) => t("sidebar.sessionCount", { count }),
  };

  const updateWidth = (event: PointerEvent) => {
    if (resizePointerId.current !== event.pointerId) return;
    previewSidebarWidth(event.clientX);
  };
  const finishResize = (event: PointerEvent) => {
    if (resizePointerId.current !== event.pointerId) return;
    resizePointerId.current = null;
    setSidebarWidth(sidebarWidth.value);
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const beginResize = (event: PointerEvent) => {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    resizePointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const openSidebarSession = (sessionId: string) => {
    openSession(sessionId);
    openMobileWorkspace();
    closeMenu();
  };

  const openMobileProfiles = () => {
    setSidebarProfilesOpen(true);
  };

  const closeMobileProfiles = () => {
    setSidebarProfilesOpen(false);
  };

  const onProfileClick = (event: MouseEvent, profileId: string) => {
    if (event.altKey || event.metaKey || event.ctrlKey) {
      openProfileMenu(event, profileId);
      return;
    }
    selectProfile(profileId);
    toggleSidebarProfileOpen(profileId);
    if (phoneViewport) closeMobileProfiles();
    closeMenu();
  };

  const onSessionClick = (event: MouseEvent, sessionId: string, profileId: string) => {
    if (event.altKey || event.metaKey || event.ctrlKey) {
      openSessionMenu(event, sessionId, profileId);
      return;
    }
    openSidebarSession(sessionId);
    if (phoneViewport) closeMobileProfiles();
  };

  const renderProfileEntry = (profile: Profile, entryKey: string) => {
    const displayName = profileDisplayName(profile);
    const secondaryName = profileSecondaryName(profile);
    const profileSessions = sessions.value.filter((session) => session.profileId === profile.id);
    const sessionsOpen = isSidebarProfileOpen(profile.id);
    return (
      <div class="sidebar-profile-entry" key={entryKey} data-sessions-open={sessionsOpen ? "true" : "false"}>
        <div class={`sidebar-profile-row ${selectedProfileId.value === profile.id ? "is-active" : ""}`}>
          <button
            class="sidebar-profile-button"
            type="button"
            aria-current={selectedProfileId.value === profile.id ? "true" : undefined}
            aria-expanded={profileSessions.length > 0 ? sessionsOpen : undefined}
            aria-label={`${displayName}${secondaryName ? ` (${secondaryName})` : ""}${profileSessions.length > 0 ? ` — ${sessionsOpen ? copy.profileCollapse : copy.profileExpand}` : ""}`}
            onClick={(event) => onProfileClick(event, profile.id)}
            onContextMenu={(event) => openProfileMenu(event, profile.id)}
          >
            <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--sidebar" decorative />
            <span class="sidebar-profile-copy">
              <b>{displayName}</b>
              {secondaryName ? <small>{secondaryName}</small> : profile.role ? <small>{profile.role}</small> : null}
              <TeamBadges profileId={profile.id} />
            </span>
            {profileSessions.length > 0 && (
              <span class="sidebar-profile-chevron" aria-hidden="true">{sessionsOpen ? "▾" : "▸"}</span>
            )}
            <StatusPill status={profile.status} />
          </button>
          <button
            class="sidebar-item-menu-trigger"
            type="button"
            aria-label={t("sidebar.menu.trigger")}
            title={t("sidebar.menu.trigger")}
            onClick={(event) => openProfileMenu(event, profile.id)}
          >⋯</button>
        </div>
        {sessionsOpen && profileSessions.length > 0 && (
          <div class="sidebar-session-list" aria-label={copy.sessionCount(profileSessions.length)}>
            {profileSessions.map((session) => {
              const isOpen = openSessionIds.value.includes(session.id);
              return (
                <div
                  key={session.id}
                  class={`sidebar-session-row ${isOpen ? "is-open" : ""} ${activeSessionId.value === session.id ? "is-active" : ""}`}
                >
                  <button
                    class="sidebar-session"
                    type="button"
                    draggable
                    data-session-id={session.id}
                    style={isOpen ? { "--session-color": profile.color } : undefined}
                    aria-current={activeSessionId.value === session.id ? "true" : undefined}
                    aria-label={`${displayName} — ${chatSessionTitle(session)}`}
                    onClick={(event) => onSessionClick(event, session.id, profile.id)}
                    onContextMenu={(event) => openSessionMenu(event, session.id, profile.id)}
                    onDragStart={(event) => {
                      event.dataTransfer?.setData("application/x-hermes-session", session.id);
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
                    }}
                  >
                    <i aria-hidden="true" />
                    <span>{chatSessionTitle(session)}</span>
                    <small>{session.status === "streaming" ? t("profile.running") : isOpen ? t("profile.open") : "·"}</small>
                    {isOpen && <em aria-hidden="true">●</em>}
                  </button>
                  <button
                    class="sidebar-item-menu-trigger"
                    type="button"
                    aria-label={t("sidebar.menu.trigger")}
                    title={t("sidebar.menu.trigger")}
                    onClick={(event) => openSessionMenu(event, session.id, profile.id)}
                  >⋯</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderGroup = (group: ProfileTeamGroup<Profile>) => (
    <section
      key={group.key}
      class={`profile-group ${group.kind === "unassigned" ? "profile-group--unassigned" : ""}`}
      aria-label={group.kind === "team" ? group.name : t("team.group.unassigned")}
    >
      <header
        class="profile-group-header"
        style={group.kind === "team" ? { "--team-color": group.color } : undefined}
      >
        <i aria-hidden="true" />
        <b title={group.kind === "team" ? group.name : t("team.group.unassigned")}>
          {group.kind === "team" ? group.name : t("team.group.unassigned")}
        </b>
        <small>{t("team.group.count", { count: group.profiles.length })}</small>
      </header>
      <div class="profile-group-body">
        {group.profiles.map((profile) => renderProfileEntry(profile, profileGroupItemKey(group.key, profile.id)))}
      </div>
    </section>
  );

  migrateHiddenRecurringSessionIds(sessions.value);
  const activeSidebarTasks = tasks.value
    .filter((task) =>
      task.status === "running"
      || task.status === "ready"
      || task.status === "blocked"
      || task.status === "review"
      || task.status === "todo"
      || task.status === "scheduled"
    )
    .slice()
    .sort((left, right) => {
      const rank = (status: string): number => {
        switch (status) {
          case "blocked": return 0;
          case "running": return 1;
          case "review": return 2;
          case "ready": return 3;
          case "todo": return 4;
          case "scheduled": return 5;
          default: return 9;
        }
      };
      const byStatus = rank(left.status) - rank(right.status);
      if (byStatus !== 0) return byStatus;
      return left.title.localeCompare(right.title);
    })
    .slice(0, 12);

  return (
    <nav
      class="side-rail"
      aria-label={t("nav.main")}
      data-mobile-route-chrome
      data-sidebar-mode={sidebarMode.value}
      data-sidebar-icon-only={iconOnly ? "true" : "false"}
      data-sidebar-profiles-open={sidebarProfilesOpen.value ? "true" : "false"}
      data-mobile-profiles-open={phoneViewport && sidebarProfilesOpen.value ? "true" : "false"}
      data-sidebar-group={groupMode}
    >
      <div class="side-rail-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            class={activeSurface.value === item.id ? "is-active" : ""}
            aria-current={activeSurface.value === item.id ? "page" : undefined}
            title={t(item.label)}
            aria-label={t(item.label)}
            onClick={() => {
              navigateToSurface(item.id);
              if (phoneViewport) closeMobileProfiles();
            }}
          >
            <span aria-hidden="true"><item.icon /></span><b class={phoneViewport ? "visually-hidden" : undefined}>{t(item.label)}</b>
          </button>
        ))}
      </div>

      <div class="side-rail-rule" aria-hidden="true" />

      <button
        class="sidebar-recurring-trigger"
        type="button"
        onClick={() => {
          openRecurringJobs();
          if (phoneViewport) closeMobileProfiles();
        }}
        title={t("nav.recurringJobs")}
        aria-label={t("nav.recurringJobs")}
      >
        <span aria-hidden="true"><ClockIcon /></span>
        <b class={phoneViewport ? "visually-hidden" : undefined}>{t("nav.recurringJobs")}</b>
        <small class={phoneViewport ? "visually-hidden" : undefined}>{recurringJobGroups(sessions.value).length}</small>
      </button>

      {phoneViewport && (
        <button
          class={`sidebar-profiles-trigger ${sidebarProfilesOpen.value ? "is-active" : ""}`}
          type="button"
          aria-expanded={sidebarProfilesOpen.value}
          aria-controls="sidebar-profiles-sheet"
          aria-label={copy.profileToggle}
          title={copy.profiles}
          onClick={() => (sidebarProfilesOpen.value ? closeMobileProfiles() : openMobileProfiles())}
        >
          <span aria-hidden="true"><UsersIcon /></span>
          <b class="visually-hidden">{copy.profiles}</b>
          <small class="visually-hidden">{copy.profileCount}</small>
        </button>
      )}

      <section class="sidebar-tasks" aria-labelledby="sidebar-tasks-title">
        <header class="sidebar-section-head">
          <button
            id="sidebar-tasks-title"
            class="sidebar-section-title"
            type="button"
            aria-expanded="true"
            aria-label={t("sidebar.tasks")}
            title={t("sidebar.tasks")}
            onClick={() => navigateToSurface("kanban")}
          >
            <b>{t("sidebar.tasks")}</b>
            <small>{t("sidebar.taskCount", { count: activeSidebarTasks.length })}</small>
          </button>
        </header>
        <div class="sidebar-tasks-list">
          {activeSidebarTasks.length === 0 ? (
            <p class="sidebar-tasks-empty">{t("sidebar.tasksEmpty")}</p>
          ) : activeSidebarTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              class="sidebar-task-button"
              onClick={() => {
                navigateToSurface("kanban");
                if (task.assigneeId) selectProfile(task.assigneeId);
              }}
              title={task.title}
            >
              <b>{task.title}</b>
              <small>
                {sidebarTaskStatusLabel(task.status)}
                {" · "}
                {task.assigneeId
                  ? sidebarTaskAssigneeName(task.assigneeId, profileList.value)
                  : t("kanban.unassigned")}
              </small>
            </button>
          ))}
        </div>
      </section>

      <section id="sidebar-profiles-sheet" class="sidebar-profiles" aria-labelledby="sidebar-profiles-title">
        <header class="sidebar-section-head">
          <button
            id="sidebar-profiles-title"
            class="sidebar-section-title"
            type="button"
            aria-expanded={sidebarProfilesOpen.value}
            aria-label={copy.profileToggle}
            title={copy.profileToggle}
            onClick={() => {
              if (phoneViewport) {
                if (sidebarProfilesOpen.value) closeMobileProfiles();
                else openMobileProfiles();
                return;
              }
              setSidebarProfilesOpen(!sidebarProfilesOpen.value);
            }}
          >
            <b>{copy.profiles}</b>
            <small>{copy.profileCount}</small>
            <span class="sidebar-section-chevron" aria-hidden="true">{sidebarProfilesOpen.value ? "−" : "+"}</span>
          </button>
          <div class="sidebar-section-head-tools">
            {hasTeams && (
              <div class="profile-group-toggle" role="group" aria-label={t("sidebar.group.aria")}>
                <button
                  type="button"
                  class={groupMode === "profiles" ? "is-active" : ""}
                  aria-pressed={groupMode === "profiles"}
                  title={t("sidebar.group.profiles")}
                  aria-label={t("sidebar.group.profiles")}
                  onClick={() => setSidebarGroupMode("profiles")}
                ><ListIcon /></button>
                <button
                  type="button"
                  class={groupMode === "teams" ? "is-active" : ""}
                  aria-pressed={groupMode === "teams"}
                  title={t("sidebar.group.teams")}
                  aria-label={t("sidebar.group.teams")}
                  onClick={() => setSidebarGroupMode("teams")}
                ><GroupIcon /></button>
              </div>
            )}
            <button
              class="sidebar-display-toggle"
              type="button"
              aria-label={copy.displayMode}
              title={copy.displayMode}
              aria-pressed={sidebarMode.value === "rows"}
              onClick={() => setSidebarMode(sidebarMode.value === "rows" ? "cards" : "rows")}
            >{sidebarMode.value === "rows" ? <CardsIcon /> : <ListIcon />}</button>
          </div>
        </header>
        {sidebarProfilesOpen.value && <div class="sidebar-profile-list">
          {grouping.mode === "flat"
            ? grouping.profiles.map((profile) => renderProfileEntry(profile, profile.id))
            : grouping.groups.map((group) => renderGroup(group))}
          {profileList.value.length === 0 && <p class="sidebar-profile-empty">—</p>}
        </div>}
        {sidebarProfilesOpen.value && inventory.hasMore && !iconOnly && (
          <button class="sidebar-more" type="button" disabled={inventory.loading} onClick={() => void loadMoreProfiles()}>
            {inventory.loading ? t("inventory.loading") : t("inventory.showMore")}
          </button>
        )}
      </section>

      <div
        class="sidebar-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label={copy.resize}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth.value}
        title={copy.resizeTitle}
        onPointerDown={beginResize}
        onPointerMove={updateWidth}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={(event) => {
          if (event.key === "Home") { event.preventDefault(); setSidebarWidth(SIDEBAR_MIN_WIDTH); }
          if (event.key === "End") { event.preventDefault(); setSidebarWidth(SIDEBAR_MAX_WIDTH); }
          if (event.key === "ArrowLeft") { event.preventDefault(); setSidebarWidth(sidebarWidth.value - 16); }
          if (event.key === "ArrowRight") { event.preventDefault(); setSidebarWidth(sidebarWidth.value + 16); }
        }}
      >
        <span aria-hidden="true" />
      </div>

      {menu && (
        <ProfileContextMenu
          menu={menu}
          menuRef={menuRef}
          onClose={closeMenu}
          onOpenSession={openMenuSession}
        />
      )}

      {sidebarWidth.value <= SIDEBAR_ICON_THRESHOLD && <span class="visually-hidden" aria-live="polite">{t("sidebar.iconOnly")}</span>}
    </nav>
  );
}
