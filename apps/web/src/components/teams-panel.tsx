import { useEffect, useMemo, useState } from "preact/hooks";
import type { OfficeTeam } from "@hermes-studio/protocol";
import {
  GLOBAL_CONTEXT_MAX_UTF8_BYTES,
  GLOBAL_SETTINGS_MAX_SKILLS,
  globalContextUtf8Bytes,
  isGlobalContextWithinBudget,
} from "@hermes-studio/protocol";
import { localizeRuntimeMessage, t } from "../i18n";
import { profileDisplayName } from "../profile-names";
import { profileList } from "../store";
import {
  createTeam,
  deleteTeam,
  refreshTeams,
  teamMutationBusy,
  teams,
  teamsState,
  teamWorkload,
  updateTeam,
  updateTeamSettings,
} from "../teams-store";
import "./teams-panel.css";

const COLOR_PRESETS = ["#64b7a7", "#e07a55", "#d6a94f", "#8499c8", "#55d6be", "#f06a57", "#9b7ed9", "#5aa9e6"] as const;

type TeamDraft = {
  name: string;
  color: string;
  description: string;
  leadProfileId: string;
  memberProfileIds: string[];
};

type SettingsDraft = {
  skillsEnabled: boolean;
  contextEnabled: boolean;
  skillsText: string;
  context: string;
};

const emptyDraft = (): TeamDraft => ({
  name: "",
  color: COLOR_PRESETS[0],
  description: "",
  leadProfileId: "",
  memberProfileIds: [],
});

function draftFromTeam(team: OfficeTeam): TeamDraft {
  return {
    name: team.name,
    color: team.color,
    description: team.description ?? "",
    leadProfileId: team.leadProfileId ?? "",
    memberProfileIds: [...team.memberProfileIds],
  };
}

function settingsFromTeam(team: OfficeTeam): SettingsDraft {
  return {
    skillsEnabled: team.settings.skillsEnabled,
    contextEnabled: team.settings.contextEnabled,
    skillsText: team.settings.skills.join("\n"),
    context: team.settings.context,
  };
}

function parseSkillLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
}

export function TeamsPanel() {
  const board = teamsState.value;
  const list = teams.value;
  const profiles = profileList.value;
  const [editor, setEditor] = useState<"create" | string | null>(null);
  const [draft, setDraft] = useState<TeamDraft>(emptyDraft);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const busy = teamMutationBusy.value;

  useEffect(() => {
    if (board.state === "idle") void refreshTeams({ acknowledgeErrors: true });
  }, [board.state]);

  const editingTeam = useMemo(
    () => (typeof editor === "string" ? list.find((team) => team.id === editor) : undefined),
    [editor, list],
  );

  const openCreate = () => {
    setFormError(null);
    setConfirmDeleteId(null);
    setDraft(emptyDraft());
    setSettingsDraft(null);
    setEditor("create");
  };

  const openEdit = (team: OfficeTeam) => {
    setFormError(null);
    setConfirmDeleteId(null);
    setDraft(draftFromTeam(team));
    setSettingsDraft(settingsFromTeam(team));
    setEditor(team.id);
  };

  const closeEditor = () => {
    setEditor(null);
    setFormError(null);
    setConfirmDeleteId(null);
    setSettingsDraft(null);
  };

  const toggleMember = (profileId: string) => {
    setDraft((current) => {
      const has = current.memberProfileIds.includes(profileId);
      const memberProfileIds = has
        ? current.memberProfileIds.filter((id) => id !== profileId)
        : [...current.memberProfileIds, profileId];
      const leadProfileId = memberProfileIds.includes(current.leadProfileId) ? current.leadProfileId : "";
      return { ...current, memberProfileIds, leadProfileId };
    });
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setFormError(null);
    const name = draft.name.trim();
    if (!name) {
      setFormError(t("teams.validation.name"));
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(draft.color)) {
      setFormError(t("teams.validation.color"));
      return;
    }
    const memberProfileIds = [...draft.memberProfileIds];
    const leadProfileId = draft.leadProfileId || null;
    if (leadProfileId && !memberProfileIds.includes(leadProfileId)) memberProfileIds.push(leadProfileId);
    const description = draft.description.trim();
    if (editor === "create") {
      const outcome = await createTeam({
        name,
        color: draft.color,
        ...(description ? { description } : {}),
        leadProfileId,
        memberProfileIds,
      });
      if (outcome === "success") closeEditor();
      else setFormError(t(outcome === "conflict" ? "teams.error.conflict" : "teams.error.save"));
      return;
    }
    if (typeof editor === "string" && editingTeam) {
      const outcome = await updateTeam(editor, {
        expectedRevision: editingTeam.revision,
        name,
        color: draft.color,
        description: description || null,
        leadProfileId,
        memberProfileIds,
      });
      if (outcome === "success") closeEditor();
      else setFormError(t(outcome === "conflict" ? "teams.error.conflict" : "teams.error.save"));
    }
  };

  const submitSettings = async () => {
    if (!editingTeam || settingsDraft === null) return;
    setFormError(null);
    const skills = parseSkillLines(settingsDraft.skillsText);
    if (skills.length > GLOBAL_SETTINGS_MAX_SKILLS) {
      setFormError(t("teams.settings.skillsOver"));
      return;
    }
    if (!isGlobalContextWithinBudget(settingsDraft.context)) {
      setFormError(t("teams.settings.contextOver"));
      return;
    }
    const outcome = await updateTeamSettings(editingTeam.id, {
      expectedRevision: editingTeam.settings.revision,
      skillsEnabled: settingsDraft.skillsEnabled,
      contextEnabled: settingsDraft.contextEnabled,
      skills,
      context: settingsDraft.context,
    });
    if (outcome === "success") {
      // Reload draft from the updated store entry.
      const next = teams.value.find((team) => team.id === editingTeam.id);
      if (next) setSettingsDraft(settingsFromTeam(next));
    } else {
      setFormError(t(outcome === "conflict" ? "teams.error.conflict" : "teams.error.save"));
    }
  };

  const confirmDelete = async (team: OfficeTeam) => {
    const outcome = await deleteTeam(team.id, team.revision);
    if (outcome === "success") closeEditor();
    else setFormError(t(outcome === "conflict" ? "teams.error.conflict" : "teams.error.delete"));
  };

  const parsedSettingsSkills = settingsDraft === null ? [] : parseSkillLines(settingsDraft.skillsText);
  const settingsContextBytes = settingsDraft === null ? 0 : globalContextUtf8Bytes(settingsDraft.context);
  const settingsSkillsValid = parsedSettingsSkills.length <= GLOBAL_SETTINGS_MAX_SKILLS;
  const settingsContextValid = settingsDraft === null || isGlobalContextWithinBudget(settingsDraft.context);
  const settingsDirty = editingTeam !== undefined && settingsDraft !== null && (
    settingsDraft.skillsEnabled !== editingTeam.settings.skillsEnabled
    || settingsDraft.contextEnabled !== editingTeam.settings.contextEnabled
    || parsedSettingsSkills.join("\n") !== editingTeam.settings.skills.join("\n")
    || settingsDraft.context !== editingTeam.settings.context
  );

  return (
    <section class="teams-page" aria-labelledby="teams-title">
      <header class="page-title-row teams-page-head">
        <div>
          <h1 id="teams-title">{t("teams.title")}</h1>
        </div>
        <div class={`teams-sync state-${board.state}`} role={board.state === "error" ? "alert" : "status"}>
          <span>{localizeRuntimeMessage(board.message)}</span>
          <button type="button" onClick={() => void refreshTeams({ acknowledgeErrors: true })} disabled={board.state === "loading" || busy}>
            {t("teams.reload")}
          </button>
        </div>
        <button class="primary-button" type="button" onClick={openCreate} disabled={busy || board.state === "loading"}>
          {t("teams.create")}
        </button>
      </header>

      {board.state === "loading" && list.length === 0 && (
        <p class="teams-empty" role="status">{t("teams.loading")}</p>
      )}
      {board.state === "error" && list.length === 0 && (
        <div class="teams-error" role="alert">
          <span>{localizeRuntimeMessage(board.message)}</span>
          <button type="button" onClick={() => void refreshTeams({ acknowledgeErrors: true })}>{t("teams.reload")}</button>
        </div>
      )}
      {board.state !== "loading" && list.length === 0 && board.state !== "error" && (
        <p class="teams-empty">{t("teams.empty")}</p>
      )}

      <div class="teams-grid">
        {list.map((team) => {
          const workload = teamWorkload(team);
          const lead = profiles.find((profile) => profile.id === team.leadProfileId);
          return (
            <article class="team-card" key={team.id} style={{ "--team-color": team.color }}>
              <header>
                <span class="team-swatch" aria-hidden="true" />
                <div>
                  <h2>{team.name}</h2>
                  {team.description && <p>{team.description}</p>}
                </div>
                <button type="button" class="quiet-button" onClick={() => openEdit(team)} disabled={busy}>
                  {t("teams.edit")}
                </button>
              </header>
              <dl class="team-meta">
                <div>
                  <dt>{t("teams.members")}</dt>
                  <dd>{t("teams.memberCount", { count: team.memberProfileIds.length })}</dd>
                </div>
                <div>
                  <dt>{t("teams.lead")}</dt>
                  <dd>{lead ? profileDisplayName(lead) : t("teams.noLead")}</dd>
                </div>
                <div>
                  <dt>{t("teams.workload")}</dt>
                  <dd>{t("teams.workloadValue", { active: workload.active, total: workload.total })}</dd>
                </div>
              </dl>
              <div class="team-settings-summary" aria-label={t("teams.settings.title")}>
                <span>{team.settings.skillsEnabled
                  ? t("teams.settings.skillsOn", { count: team.settings.skills.length })
                  : t("teams.settings.skillsOff")}</span>
                <span>{team.settings.contextEnabled
                  ? (team.settings.context.trim() === "" ? t("teams.settings.contextEmpty") : t("teams.settings.contextOn"))
                  : t("teams.settings.contextOff")}</span>
              </div>
              {team.settings.skillsEnabled && team.settings.skills.length > 0 && (
                <ul class="team-skill-chips" aria-label={t("teams.settings.skills")}>
                  {team.settings.skills.map((skill) => <li key={skill}>{skill}</li>)}
                </ul>
              )}
              <ul class="team-member-chips" aria-label={t("teams.members")}>
                {team.memberProfileIds.map((profileId) => {
                  const profile = profiles.find((item) => item.id === profileId);
                  return (
                    <li key={profileId}>
                      <i style={{ background: profile?.color ?? team.color }} />
                      {profile ? profileDisplayName(profile) : profileId}
                    </li>
                  );
                })}
                {team.memberProfileIds.length === 0 && <li class="is-empty">{t("teams.noMembers")}</li>}
              </ul>
            </article>
          );
        })}
      </div>

      {editor !== null && (
        <div class="teams-editor-backdrop" role="presentation" onClick={closeEditor}>
          <form
            class="teams-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="teams-editor-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => void submit(event)}
          >
            <header>
              <h2 id="teams-editor-title">{editor === "create" ? t("teams.createTitle") : t("teams.editTitle")}</h2>
              <button type="button" class="mobile-close" onClick={closeEditor} aria-label={t("common.close")}>×</button>
            </header>
            <label>
              <span>{t("teams.field.name")}</span>
              <input
                value={draft.name}
                maxLength={64}
                required
                autoFocus
                disabled={busy}
                onInput={(event) => setDraft((current) => ({ ...current, name: event.currentTarget.value }))}
              />
            </label>
            <label>
              <span>{t("teams.field.color")}</span>
              <div class="teams-color-row">
                {COLOR_PRESETS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    class={draft.color.toLowerCase() === color ? "is-active" : ""}
                    style={{ background: color }}
                    aria-label={color}
                    aria-pressed={draft.color.toLowerCase() === color}
                    disabled={busy}
                    onClick={() => setDraft((current) => ({ ...current, color }))}
                  />
                ))}
                <input
                  type="text"
                  value={draft.color}
                  maxLength={7}
                  pattern="#[0-9A-Fa-f]{6}"
                  disabled={busy}
                  aria-label={t("teams.field.colorCustom")}
                  onInput={(event) => setDraft((current) => ({ ...current, color: event.currentTarget.value }))}
                />
              </div>
            </label>
            <label>
              <span>{t("teams.field.description")}</span>
              <textarea
                value={draft.description}
                maxLength={500}
                rows={3}
                disabled={busy}
                placeholder={t("teams.field.descriptionPlaceholder")}
                onInput={(event) => setDraft((current) => ({ ...current, description: event.currentTarget.value }))}
              />
            </label>
            <fieldset class="teams-members-field" disabled={busy}>
              <legend>{t("teams.field.members")}</legend>
              <p class="teams-members-hint">{t("teams.field.membersHint")}</p>
              <div class="teams-member-picker">
                {profiles.map((profile) => {
                  const checked = draft.memberProfileIds.includes(profile.id);
                  return (
                    <label key={profile.id} class={checked ? "is-checked" : ""}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleMember(profile.id)}
                      />
                      <i style={{ background: profile.color }} />
                      <span>{profileDisplayName(profile)}</span>
                    </label>
                  );
                })}
                {profiles.length === 0 && <p class="teams-members-empty">{t("teams.noProfiles")}</p>}
              </div>
            </fieldset>
            <label>
              <span>{t("teams.field.lead")}</span>
              <select
                value={draft.leadProfileId}
                disabled={busy}
                onChange={(event) => setDraft((current) => ({ ...current, leadProfileId: event.currentTarget.value }))}
              >
                <option value="">{t("teams.noLead")}</option>
                {draft.memberProfileIds.map((profileId) => {
                  const profile = profiles.find((item) => item.id === profileId);
                  return (
                    <option key={profileId} value={profileId}>
                      {profile ? profileDisplayName(profile) : profileId}
                    </option>
                  );
                })}
              </select>
            </label>

            {editingTeam && settingsDraft && (
              <fieldset class="teams-settings-field" disabled={busy}>
                <legend>{t("teams.settings.title")}</legend>
                <p class="teams-members-hint">{t("teams.settings.hint")}</p>
                <label class="teams-settings-switch">
                  <span>
                    <b>{t("teams.settings.skillsEnabled")}</b>
                    <small>{t("teams.settings.skillsEnabledDetail")}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settingsDraft.skillsEnabled}
                    onChange={(event) => setSettingsDraft((current) => current === null ? current : ({
                      ...current,
                      skillsEnabled: event.currentTarget.checked,
                    }))}
                  />
                </label>
                <label class="teams-settings-switch">
                  <span>
                    <b>{t("teams.settings.contextEnabled")}</b>
                    <small>{t("teams.settings.contextEnabledDetail")}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settingsDraft.contextEnabled}
                    onChange={(event) => setSettingsDraft((current) => current === null ? current : ({
                      ...current,
                      contextEnabled: event.currentTarget.checked,
                    }))}
                  />
                </label>
                <label>
                  <span>{t("teams.settings.skills")}</span>
                  <textarea
                    value={settingsDraft.skillsText}
                    rows={5}
                    spellcheck={false}
                    disabled={busy}
                    aria-invalid={!settingsSkillsValid}
                    placeholder={"browser\nresearch"}
                    onInput={(event) => setSettingsDraft((current) => current === null ? current : ({
                      ...current,
                      skillsText: event.currentTarget.value,
                    }))}
                  />
                  <small class={`teams-settings-budget ${settingsSkillsValid ? "" : "is-over"}`}>
                    {t("settings.skillBudget", { count: parsedSettingsSkills.length, max: GLOBAL_SETTINGS_MAX_SKILLS })}
                  </small>
                  {parsedSettingsSkills.length > 0 && (
                    <ul class="team-skill-chips teams-settings-chips" aria-label={t("teams.settings.skills")}>
                      {parsedSettingsSkills.map((skill) => <li key={skill}>{skill}</li>)}
                    </ul>
                  )}
                </label>
                <label>
                  <span>{t("teams.settings.context")}</span>
                  <textarea
                    value={settingsDraft.context}
                    rows={5}
                    disabled={busy}
                    aria-invalid={!settingsContextValid}
                    placeholder={t("teams.settings.contextPlaceholder")}
                    onInput={(event) => setSettingsDraft((current) => current === null ? current : ({
                      ...current,
                      context: event.currentTarget.value,
                    }))}
                  />
                  <small class={`teams-settings-budget ${settingsContextValid ? "" : "is-over"}`}>
                    {t("settings.contextBudget", { count: settingsContextBytes, max: GLOBAL_CONTEXT_MAX_UTF8_BYTES })}
                  </small>
                </label>
                <div class="teams-settings-actions">
                  <span>{settingsDirty ? t("settings.unsaved") : t("settings.upToDate")}</span>
                  <button
                    type="button"
                    class="primary-button"
                    disabled={busy || !settingsDirty || !settingsSkillsValid || !settingsContextValid}
                    onClick={() => void submitSettings()}
                  >
                    {busy ? t("settings.saving") : t("teams.settings.save")}
                  </button>
                </div>
              </fieldset>
            )}

            {formError && <p class="teams-form-error" role="alert">{formError}</p>}
            <footer>
              {editingTeam && (
                confirmDeleteId === editingTeam.id ? (
                  <div class="teams-delete-confirm">
                    <span>{t("teams.deleteConfirm", { name: editingTeam.name })}</span>
                    <button type="button" class="danger-button" disabled={busy} onClick={() => void confirmDelete(editingTeam)}>
                      {t("teams.deleteForever")}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setConfirmDeleteId(null)}>{t("common.cancel")}</button>
                  </div>
                ) : (
                  <button type="button" class="danger-button" disabled={busy} onClick={() => setConfirmDeleteId(editingTeam.id)}>
                    {t("teams.delete")}
                  </button>
                )
              )}
              <span class="teams-editor-spacer" />
              <button type="button" disabled={busy} onClick={closeEditor}>{t("common.cancel")}</button>
              <button class="primary-button" type="submit" disabled={busy}>{t("teams.save")}</button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}
