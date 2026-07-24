import { computed, signal } from "@preact/signals";
import type { OfficeTeam } from "@hermes-studio/protocol";
import { officeMessage, type RuntimeMessage } from "./i18n";
import {
  createDemoTeamsApi,
  createTeamsApi,
  TeamsMutationFailure,
  type CreateTeamInput,
  type TeamsApi,
  type UpdateTeamInput,
  type UpdateTeamSettingsInput,
} from "./teams-api";
import { tasks } from "./kanban-store";

export type TeamsConnectionState = "idle" | "loading" | "ready" | "saving" | "error";
export type TeamsSubmissionOutcome = "success" | "rejected" | "conflict" | "commit-unknown" | "stale";

type TeamsState = {
  state: TeamsConnectionState;
  message: RuntimeMessage;
};

export const teams = signal<OfficeTeam[]>([]);
export const teamsState = signal<TeamsState>({
  state: "idle",
  message: officeMessage("runtime.teams.connecting"),
});
/** Kanban board filter: empty string means all teams. */
export const kanbanTeamFilterId = signal<string>("");
export const teamMutationBusy = signal(false);

let teamsApi: TeamsApi | undefined;
let liveTeamsApi: TeamsApi | undefined;
let demoRuntimeActive = false;
let runtimeGeneration = 0;
let loadFlight: Promise<boolean> | undefined;

export function registerTeamsRuntime(api: TeamsApi): void {
  liveTeamsApi = api;
  if (demoRuntimeActive) return;
  activateRuntime(api);
  void refreshTeams({ acknowledgeErrors: true });
}

export function loadTeamsDemoRuntime(seed: readonly OfficeTeam[]): void {
  demoRuntimeActive = true;
  activateRuntime(createDemoTeamsApi(seed));
  teamsState.value = { state: "loading", message: officeMessage("runtime.teams.loading") };
  void refreshTeams({ acknowledgeErrors: true });
}

export function resetTeamsRuntimeState(): void {
  demoRuntimeActive = false;
  loadFlight = undefined;
  teamMutationBusy.value = false;
  kanbanTeamFilterId.value = "";
  activateRuntime(liveTeamsApi);
  teamsState.value = { state: "idle", message: officeMessage("runtime.teams.waiting") };
}

function activateRuntime(api: TeamsApi | undefined): void {
  runtimeGeneration += 1;
  teamsApi = api;
  teamMutationBusy.value = false;
  teams.value = [];
}

export async function refreshTeams(options: { acknowledgeErrors?: boolean } = {}): Promise<boolean> {
  if (!teamsApi) return false;
  const runtime = runtimeGeneration;
  if (options.acknowledgeErrors) {
    /* no sticky error to clear beyond state */
  }
  if (loadFlight) return loadFlight;
  loadFlight = (async () => {
    try {
      if (teamsState.value.state !== "saving") {
        teamsState.value = { state: "loading", message: officeMessage("runtime.teams.loading") };
      }
      const result = await teamsApi!.list();
      if (runtime !== runtimeGeneration) return false;
      teams.value = result.teams;
      if (kanbanTeamFilterId.value && !result.teams.some((team) => team.id === kanbanTeamFilterId.value)) {
        kanbanTeamFilterId.value = "";
      }
      teamsState.value = {
        state: "ready",
        message: officeMessage("runtime.teams.count", { count: result.teams.length }),
      };
      return true;
    } catch {
      if (runtime !== runtimeGeneration) return false;
      teamsState.value = {
        state: "error",
        message: officeMessage("runtime.teams.loadFailed"),
      };
      return false;
    } finally {
      loadFlight = undefined;
    }
  })();
  return loadFlight;
}

export async function createTeam(input: CreateTeamInput): Promise<TeamsSubmissionOutcome> {
  if (!teamsApi || teamMutationBusy.value) return "stale";
  const runtime = runtimeGeneration;
  teamMutationBusy.value = true;
  teamsState.value = { state: "saving", message: officeMessage("runtime.teams.creating") };
  try {
    const created = await teamsApi.create(input);
    if (runtime !== runtimeGeneration) return "stale";
    teams.value = [...teams.value, created];
    teamsState.value = {
      state: "ready",
      message: officeMessage("runtime.teams.count", { count: teams.value.length }),
    };
    return "success";
  } catch (error) {
    if (runtime !== runtimeGeneration) return "stale";
    return applyMutationFailure(error);
  } finally {
    if (runtime === runtimeGeneration) teamMutationBusy.value = false;
  }
}

export async function updateTeam(teamId: string, input: UpdateTeamInput): Promise<TeamsSubmissionOutcome> {
  if (!teamsApi || teamMutationBusy.value) return "stale";
  const runtime = runtimeGeneration;
  const previous = teams.value;
  const index = previous.findIndex((team) => team.id === teamId);
  if (index < 0) return "rejected";
  const current = previous[index]!;
  const optimistic: OfficeTeam = {
    id: current.id,
    name: input.name ?? current.name,
    color: input.color ?? current.color,
    ...((): { description?: string } => {
      if (input.description === undefined) {
        return current.description === undefined ? {} : { description: current.description };
      }
      if (input.description === null || input.description === "") return {};
      return { description: input.description };
    })(),
    ...((): { leadProfileId?: string } => {
      if (input.leadProfileId === undefined) {
        return current.leadProfileId === undefined ? {} : { leadProfileId: current.leadProfileId };
      }
      if (input.leadProfileId === null) return {};
      return { leadProfileId: input.leadProfileId };
    })(),
    memberProfileIds: input.memberProfileIds === undefined
      ? [...current.memberProfileIds]
      : [...input.memberProfileIds],
    settings: {
      ...current.settings,
      skills: [...current.settings.skills],
    },
    revision: current.revision,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  };
  teamMutationBusy.value = true;
  teams.value = previous.map((team, i) => i === index ? optimistic : team);
  teamsState.value = { state: "saving", message: officeMessage("runtime.teams.updating") };
  try {
    const updated = await teamsApi.update(teamId, input);
    if (runtime !== runtimeGeneration) return "stale";
    teams.value = teams.value.map((team) => team.id === teamId ? updated : team);
    teamsState.value = {
      state: "ready",
      message: officeMessage("runtime.teams.count", { count: teams.value.length }),
    };
    return "success";
  } catch (error) {
    if (runtime !== runtimeGeneration) return "stale";
    teams.value = previous;
    return applyMutationFailure(error);
  } finally {
    if (runtime === runtimeGeneration) teamMutationBusy.value = false;
  }
}

export async function updateTeamSettings(
  teamId: string,
  input: UpdateTeamSettingsInput,
): Promise<TeamsSubmissionOutcome> {
  if (!teamsApi || teamMutationBusy.value) return "stale";
  const runtime = runtimeGeneration;
  const previous = teams.value;
  const index = previous.findIndex((team) => team.id === teamId);
  if (index < 0) return "rejected";
  const current = previous[index]!;
  teamMutationBusy.value = true;
  teamsState.value = { state: "saving", message: officeMessage("runtime.teams.updating") };
  try {
    const settings = await teamsApi.updateSettings(teamId, input);
    if (runtime !== runtimeGeneration) return "stale";
    teams.value = teams.value.map((team) => team.id === teamId
      ? {
          ...team,
          settings: {
            revision: settings.revision,
            skillsEnabled: settings.skillsEnabled,
            contextEnabled: settings.contextEnabled,
            skills: [...settings.skills],
            context: settings.context,
            updatedAt: settings.updatedAt,
          },
          updatedAt: settings.updatedAt,
        }
      : team);
    teamsState.value = {
      state: "ready",
      message: officeMessage("runtime.teams.count", { count: teams.value.length }),
    };
    return "success";
  } catch (error) {
    if (runtime !== runtimeGeneration) return "stale";
    teams.value = previous;
    return applyMutationFailure(error);
  } finally {
    if (runtime === runtimeGeneration) teamMutationBusy.value = false;
  }
}

export async function deleteTeam(teamId: string, expectedRevision: number): Promise<TeamsSubmissionOutcome> {
  if (!teamsApi || teamMutationBusy.value) return "stale";
  const runtime = runtimeGeneration;
  const previous = teams.value;
  teamMutationBusy.value = true;
  teams.value = previous.filter((team) => team.id !== teamId);
  if (kanbanTeamFilterId.value === teamId) kanbanTeamFilterId.value = "";
  teamsState.value = { state: "saving", message: officeMessage("runtime.teams.deleting") };
  try {
    await teamsApi.remove(teamId, expectedRevision);
    if (runtime !== runtimeGeneration) return "stale";
    teamsState.value = {
      state: "ready",
      message: officeMessage("runtime.teams.count", { count: teams.value.length }),
    };
    return "success";
  } catch (error) {
    if (runtime !== runtimeGeneration) return "stale";
    teams.value = previous;
    return applyMutationFailure(error);
  } finally {
    if (runtime === runtimeGeneration) teamMutationBusy.value = false;
  }
}

export function setKanbanTeamFilter(teamId: string): void {
  kanbanTeamFilterId.value = teamId;
}

/** Teams that include the given Hermes profile (many-to-many). */
export function teamsForProfile(profileId: string): OfficeTeam[] {
  return teams.value.filter((team) => team.memberProfileIds.includes(profileId));
}

/** Open Kanban task counts for members of a team (assignment remains per-profile). */
export function teamWorkload(team: OfficeTeam): { total: number; active: number } {
  const members = new Set(team.memberProfileIds);
  let total = 0;
  let active = 0;
  for (const task of tasks.value) {
    if (!task.assigneeId || !members.has(task.assigneeId)) continue;
    total += 1;
    if (task.status !== "done" && task.status !== "archived") active += 1;
  }
  return { total, active };
}

export const filteredKanbanTasks = computed(() => {
  const filterId = kanbanTeamFilterId.value;
  if (!filterId) return null;
  const team = teams.value.find((item) => item.id === filterId);
  if (!team) return null;
  const members = new Set(team.memberProfileIds);
  return tasks.value.filter((task) => task.assigneeId !== undefined && members.has(task.assigneeId));
});

function applyMutationFailure(error: unknown): TeamsSubmissionOutcome {
  if (error instanceof TeamsMutationFailure) {
    if (error.kind === "conflict") {
      teamsState.value = { state: "error", message: officeMessage("runtime.teams.conflict") };
      void refreshTeams();
      return "conflict";
    }
    if (error.kind === "commit-unknown") {
      teamsState.value = { state: "error", message: officeMessage("runtime.teams.unknown") };
      void refreshTeams();
      return "commit-unknown";
    }
    teamsState.value = { state: "error", message: officeMessage("runtime.teams.updateFailed") };
    return "rejected";
  }
  teamsState.value = { state: "error", message: officeMessage("runtime.teams.updateFailed") };
  return "rejected";
}

/** Default live API factory for app bootstrap. */
export { createTeamsApi };
