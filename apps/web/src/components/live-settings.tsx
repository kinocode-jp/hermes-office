import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  GLOBAL_CONTEXT_MAX_UTF8_BYTES,
  GLOBAL_SETTINGS_MAX_SKILLS,
  globalContextUtf8Bytes,
  isGlobalContextWithinBudget,
} from "@hermes-office/protocol";
import type { SettingsTab } from "../domain";
import { localizeRuntimeMessage, officeMessage, officeRuntimeMessage, t, type RuntimeMessage } from "../i18n";
import { canMutateSettingsTab, settingsMutationAccess } from "../settings-access";
import { preserveConcurrentDraft } from "../settings-draft";
import { SettingsMutationRegistry, type SettingsMutationScope } from "../settings-mutation-registry";
import { officeSnapshot } from "../store";
import { AccessAudit } from "./access-audit";
import { DeviceAdmin } from "./device-admin";
import { InfoTip } from "./info-tip";
import {
  SettingsApiError,
  loadGlobalSettings,
  loadMemoryProviderConfig,
  loadProfileSettings,
  setMemoryProvider,
  setSkillEnabled,
  updateGlobalSettings,
  updateMemoryProviderConfig,
  updateProfileSoul,
  type GlobalAgentSettings,
  type MemoryProviderConfig,
  type ProfileAgentSettings,
} from "../settings-api";
import "./live-settings.css";

export type LiveSettingsProps = {
  profileId: string | null;
  profileLabel?: string;
  initialTab?: SettingsTab;
  activeTab?: SettingsTab;
  showAccessAudit?: boolean;
  showHostAdmin?: boolean;
  onTabChange?: (tab: SettingsTab) => void;
  onChanged?: (kind: "global" | "memory" | "skill" | "soul") => void;
};

type ErrorState = { message: RuntimeMessage; conflict: boolean };

export function LiveSettings({ profileId, profileLabel, initialTab = "global", activeTab, showAccessAudit = false, showHostAdmin = false, onTabChange, onChanged }: LiveSettingsProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const visibleTab = activeTab ?? tab;
  const [global, setGlobal] = useState<GlobalAgentSettings | null>(null);
  const [profile, setProfile] = useState<ProfileAgentSettings | null>(null);
  const [providerConfig, setProviderConfig] = useState<MemoryProviderConfig | null>(null);
  const [globalContext, setGlobalContext] = useState("");
  const [globalSkills, setGlobalSkills] = useState("");
  const [sharedContext, setSharedContext] = useState(true);
  const [sharedSkills, setSharedSkills] = useState(true);
  const [soulDraft, setSoulDraft] = useState("");
  const [providerDraft, setProviderDraft] = useState("");
  const [providerValues, setProviderValues] = useState<Record<string, boolean | string>>({});
  const [skillQuery, setSkillQuery] = useState("");
  const [skillLimit, setSkillLimit] = useState(30);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<ErrorState | null>(null);
  const generation = useRef(0);
  const mutations = useRef(new SettingsMutationRegistry());
  const snapshot = officeSnapshot.value;
  const mutationAccess = settingsMutationAccess(snapshot);
  const canReadAudit = snapshot?.capabilities.access.allowedOperations.includes("audit.read") === true;
  const hostAdmin = showHostAdmin && mutationAccess.hostAdmin;

  const loadProvider = useCallback(async (targetProfile: string, provider: string, expectedGeneration: number) => {
    if (!provider) {
      if (generation.current === expectedGeneration) {
        setProviderConfig(null);
        setProviderValues({});
      }
      return;
    }
    try {
      const config = await loadMemoryProviderConfig(targetProfile, provider);
      if (generation.current !== expectedGeneration) return;
      setProviderConfig(config);
      setProviderValues(valuesFromConfig(config));
    } catch (reason) {
      if (generation.current === expectedGeneration) setError(errorState(reason));
    }
  }, []);

  const reload = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    setProviderConfig(null);
    try {
      const [nextGlobal, nextProfile] = await Promise.all([
        loadGlobalSettings(),
        profileId ? loadProfileSettings(profileId) : Promise.resolve(null),
      ]);
      if (generation.current !== currentGeneration) return;
      setGlobal(nextGlobal);
      setGlobalContext(nextGlobal.context);
      setGlobalSkills(nextGlobal.skills.join("\n"));
      setSharedContext(nextGlobal.sharedContextEnabled);
      setSharedSkills(nextGlobal.sharedSkillsEnabled);
      setProfile(nextProfile);
      setSoulDraft(nextProfile?.soul.content ?? "");
      setProviderDraft(nextProfile?.memory.activeProvider ?? "");
      if (nextProfile) await loadProvider(nextProfile.profile, nextProfile.memory.activeProvider, currentGeneration);
    } catch (reason) {
      if (generation.current === currentGeneration) setError(errorState(reason));
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [loadProvider, profileId]);

  useEffect(() => {
    if (visibleTab === "host") {
      generation.current += 1;
      setLoading(false);
      setError(null);
      setGlobal(null);
      setProfile(null);
      setProviderConfig(null);
      setProviderValues({});
      setSoulDraft("");
      setProviderDraft("");
      return;
    }
    void reload();
    return () => { generation.current += 1; };
  }, [reload, visibleTab]);

  useEffect(() => { setSkillLimit(30); }, [profileId, skillQuery]);

  const perform = useCallback(async (key: string, scope: SettingsMutationScope, action: () => Promise<void>, kind: "global" | "memory" | "skill" | "soul") => {
    if (!mutations.current.start(key, scope)) return;
    setBusy(mutations.current.snapshot());
    setError(null);
    try {
      await action();
      onChanged?.(kind);
    } catch (reason) {
      setError(errorState(reason));
    } finally {
      mutations.current.finish(key);
      setBusy(mutations.current.snapshot());
    }
  }, [onChanged]);

  const saveGlobal = () => {
    if (!global || !mutationAccess.global) return;
    const submitted = { globalContext, globalSkills, sharedContext, sharedSkills };
    void perform("global", "global", async () => {
      const updated = await updateGlobalSettings({
        expectedRevision: global.revision,
        sharedContextEnabled: submitted.sharedContext,
        sharedSkillsEnabled: submitted.sharedSkills,
        context: submitted.globalContext,
        skills: parseSkillLines(submitted.globalSkills),
      });
      setGlobal(updated);
      setGlobalContext((current) => preserveConcurrentDraft(current, submitted.globalContext, updated.context));
      setGlobalSkills((current) => preserveConcurrentDraft(current, submitted.globalSkills, updated.skills.join("\n")));
      setSharedContext((current) => preserveConcurrentDraft(current, submitted.sharedContext, updated.sharedContextEnabled));
      setSharedSkills((current) => preserveConcurrentDraft(current, submitted.sharedSkills, updated.sharedSkillsEnabled));
    }, "global");
  };

  const toggleSkill = (name: string, enabled: boolean) => {
    if (!profile || !mutationAccess.skill) return;
    void perform(`skill:${name}`, `skill:${name}`, async () => {
      await setSkillEnabled(profile.profile, name, !enabled, enabled);
      setProfile((current) => current === null ? current : {
        ...current,
        skills: current.skills.map((skill) => skill.name === name ? { ...skill, enabled: !enabled } : skill),
      });
    }, "skill");
  };

  const saveSoul = () => {
    if (!profile || profile.soul.redacted || !mutationAccess.soul) return;
    const submittedDraft = soulDraft;
    void perform("soul", "soul", async () => {
      const updated = await updateProfileSoul(profile.profile, submittedDraft, profile.soul.revision);
      setProfile((current) => current === null ? current : { ...current, soul: updated });
      setSoulDraft((current) => preserveConcurrentDraft(current, submittedDraft, updated.content));
    }, "soul");
  };

  const saveProvider = () => {
    if (!profile || !mutationAccess.memory || providerDraft === profile.memory.activeProvider) return;
    void perform("provider", "memory", async () => {
      const memory = await setMemoryProvider(profile.profile, providerDraft, profile.memory.activeProvider);
      setProfile((current) => current === null ? current : { ...current, memory });
      const currentGeneration = generation.current;
      await loadProvider(profile.profile, memory.activeProvider, currentGeneration);
    }, "memory");
  };

  const saveProviderConfig = () => {
    if (!profile || !providerConfig || !mutationAccess.memory) return;
    void perform("provider-config", "memory", async () => {
      const updated = await updateMemoryProviderConfig(
        profile.profile,
        providerConfig.name,
        providerValues,
        providerConfig.revision,
      );
      setProviderConfig(updated);
      setProviderValues(valuesFromConfig(updated));
    }, "memory");
  };

  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase();
    if (!query) return profile?.skills ?? [];
    return (profile?.skills ?? []).filter((skill) => `${skill.name} ${skill.description} ${skill.category}`.toLocaleLowerCase().includes(query));
  }, [profile, skillQuery]);
  const visibleSkills = filteredSkills.slice(0, skillLimit);
  const parsedGlobalSkills = parseSkillLines(globalSkills);
  const globalContextBytes = globalContextUtf8Bytes(globalContext);
  const globalContextValid = isGlobalContextWithinBudget(globalContext);
  const globalSkillsValid = parsedGlobalSkills.length <= GLOBAL_SETTINGS_MAX_SKILLS;
  const currentTabWritable = canMutateSettingsTab(mutationAccess, visibleTab);

  const profileName = profileLabel || profile?.profile || profileId || t("settings.noProfile");
  const globalDirty = global !== null && (
    global.context !== globalContext ||
    global.skills.join("\n") !== parsedGlobalSkills.join("\n") ||
    global.sharedContextEnabled !== sharedContext ||
    global.sharedSkillsEnabled !== sharedSkills
  );
  const soulDirty = profile !== null && profile.soul.content !== soulDraft;
  const providerConfigDirty = providerConfig !== null && JSON.stringify(providerValues) !== JSON.stringify(valuesFromConfig(providerConfig));
  const memoryBusy = busy.has("provider") || busy.has("provider-config");

  return (
    <section class="live-settings" aria-busy={loading}>
      <header class="live-settings__mast">
        <div>
          <p>{t("settings.eyebrow")}</p>
          <h1>{t("settings.title")}</h1>
        </div>
        <div class="live-settings__target">
          <span>{t("settings.target")}</span>
          <b>{profileName}</b>
        </div>
      </header>

      {showAccessAudit && canReadAudit && <AccessAudit />}

      {hostAdmin ? (
        visibleTab !== "host" && !currentTabWritable && (
          <div class="live-settings__notice is-read-only" role="status">
            <span>{t("settings.readOnly")}</span>
            <p>{mutationAccess.localOwner ? t("settings.permissionUnavailable") : t("settings.localOwnerRequired")}</p>
          </div>
        )
      ) : (
        !currentTabWritable && (
          <div class="live-settings__notice is-read-only" role="status">
            <span>{t("settings.readOnly")}</span>
            <p>{mutationAccess.localOwner ? t("settings.permissionUnavailable") : t("settings.localOwnerRequired")}</p>
          </div>
        )
      )}

      <nav class="live-settings__tabs" aria-label={t("settings.categories")}>
        {([
          ["global", t("settings.global")],
          ["skills", t("settings.skills")],
          ["soul", t("settings.identity")],
          ["memory", t("settings.memory")],
          ...(hostAdmin ? [["host", t("hostAdmin.title")] as const] : []),
        ] as const).map(([id, label]) => (
          <button key={id} type="button" class={visibleTab === id ? "is-active" : ""} aria-current={visibleTab === id ? "page" : undefined} onClick={() => { setTab(id); onTabChange?.(id); }} disabled={id !== "global" && id !== "host" && !profileId}>
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <div class={`live-settings__notice ${error.conflict ? "is-conflict" : "is-error"}`} role="alert">
          <span>{error.conflict ? t("settings.conflict") : t("settings.offline")}</span>
          <p>{localizeRuntimeMessage(error.message)}</p>
          <button type="button" onClick={() => void reload()}>{t("settings.reload")}</button>
        </div>
      )}

      {loading && visibleTab !== "host" ? (
        <SettingsSkeleton />
      ) : visibleTab === "host" ? (
        hostAdmin && <DeviceAdmin />
      ) : visibleTab === "global" ? (
        <div class="live-settings__grid live-settings__global">
          {global?.skillSync.state === "pending" && (
            <div class="live-settings__notice is-conflict settings-sync-notice" role="status">
              <span>{t("settings.syncPending")}</span>
              <p>{t("settings.syncPendingDetail")}</p>
              <div class="settings-sync-failures" aria-label={t("settings.syncFailures")}>
                {global.skillSync.failures.slice(0, 5).map((failure) => (
                  <small key={`${failure.profile}-${failure.skill}-${failure.operation}`}>{failure.profile} / {failure.skill} / {failure.operation}</small>
                ))}
              </div>
            </div>
          )}
          <aside class="inheritance-bus" aria-label={t("settings.globalBus")}>
            <span>{t("settings.globalBus")}</span><i /><b>{t("settings.inherit")}</b>
          </aside>
          <div class="settings-ledger">
            <SectionHead code="UTIL-01" title={t("settings.inheritance")} note={`revision ${global?.revision ?? "—"}`} />
            <SwitchRow label={t("settings.sharedSkills")} detail={t("settings.sharedSkillsDetail")} checked={sharedSkills} disabled={!mutationAccess.global} onChange={setSharedSkills} />
            <SwitchRow label={t("settings.sharedContext")} detail={t("settings.sharedContextDetail")} checked={sharedContext} disabled={!mutationAccess.global} onChange={setSharedContext} />
          </div>
          <div class="settings-ledger">
            <SectionHead code="UTIL-02" title={t("settings.globalSkills")} note={t("settings.onePerLine")} />
            <textarea value={globalSkills} onInput={(event) => setGlobalSkills(event.currentTarget.value)} rows={7} spellcheck={false} disabled={!mutationAccess.global} aria-invalid={!globalSkillsValid} placeholder={"browser\ncoding\nresearch"} />
            <small class={`settings-budget ${globalSkillsValid ? "" : "is-over"}`}>{t("settings.skillBudget", { count: parsedGlobalSkills.length, max: GLOBAL_SETTINGS_MAX_SKILLS })}</small>
          </div>
          <div class="settings-ledger settings-ledger--wide">
            <SectionHead code="UTIL-03" title={t("settings.sharedContext")} info={t("settings.noSecrets")} />
            <textarea value={globalContext} onInput={(event) => setGlobalContext(event.currentTarget.value)} rows={8} disabled={!mutationAccess.global} aria-invalid={!globalContextValid} aria-describedby="global-context-budget" placeholder={t("settings.contextPlaceholder")} />
            <small id="global-context-budget" class={`settings-budget ${globalContextValid ? "" : "is-over"}`}>{t("settings.contextBudget", { count: globalContextBytes, max: GLOBAL_CONTEXT_MAX_UTF8_BYTES })}</small>
            <ActionBar dirty={globalDirty} retryPending={global?.skillSync.state === "pending"} busy={busy.has("global")} permitted={mutationAccess.global} valid={globalContextValid && globalSkillsValid} onSave={saveGlobal} />
          </div>
        </div>
      ) : !profile ? (
        <EmptyProfile onReload={reload} />
      ) : visibleTab === "skills" ? (
        <div class="live-settings__skills">
          <div class="settings-toolbar">
            <div><b>{profile.skills.filter((skill) => skill.enabled).length}</b><span>{t("settings.enabledAvailable", { count: profile.skills.length })}</span></div>
            <input type="search" value={skillQuery} onInput={(event) => setSkillQuery(event.currentTarget.value)} placeholder={t("settings.skillSearch")} aria-label={t("settings.skillSearch")} />
          </div>
          <div class="skill-switchboard">
            {visibleSkills.map((skill) => (
              <article class={`skill-line ${skill.enabled ? "is-enabled" : ""}`} key={skill.name}>
                <span class="skill-line__light" aria-hidden="true" />
                <div><b>{skill.name}</b><p>{skill.description || t("settings.noDescription")}</p></div>
                <small>{skill.provenance} · {skill.category}</small>
                <button type="button" role="switch" aria-checked={skill.enabled} disabled={!mutationAccess.skill || busy.has(`skill:${skill.name}`)} onClick={() => toggleSkill(skill.name, skill.enabled)}>
                  {busy.has(`skill:${skill.name}`) ? "…" : skill.enabled ? "ON" : "OFF"}
                </button>
              </article>
            ))}
            {filteredSkills.length === 0 && <p class="settings-empty">{t("settings.noSkills")}</p>}
            {filteredSkills.length > visibleSkills.length && (
              <button class="settings-load-more" type="button" onClick={() => setSkillLimit((current) => current + 30)}>
                {t("settings.showMore", { count: filteredSkills.length - visibleSkills.length })}
              </button>
            )}
          </div>
        </div>
      ) : visibleTab === "soul" ? (
        <div class="settings-ledger settings-ledger--editor">
          <SectionHead code="IDENTITY" title={`${profile.profile} / SOUL.md`} note={`revision ${shortRevision(profile.soul.revision)}`} info={t("settings.soulNote")} />
          {profile.soul.redacted && <p class="settings-warning">{t("settings.redacted")}</p>}
          <textarea value={soulDraft} onInput={(event) => setSoulDraft(event.currentTarget.value)} rows={18} disabled={profile.soul.redacted || !mutationAccess.soul} spellcheck={false} />
          <ActionBar dirty={soulDirty && !profile.soul.redacted} busy={busy.has("soul")} permitted={mutationAccess.soul} onSave={saveSoul} />
        </div>
      ) : (
        <div class="live-settings__memory">
          <div class="memory-gauge">
            <p>{t("settings.builtinMemory")} <InfoTip text={t("settings.memoryReadOnly")} align="start" /></p>
            <div><span><b>{formatBytes(profile.memory.builtin.memoryBytes)}</b>MEMORY.md</span><i /><span><b>{formatBytes(profile.memory.builtin.userBytes)}</b>USER.md</span></div>
          </div>
          <div class="settings-ledger">
            <SectionHead code="MEM-01" title={t("settings.memoryProvider")} note={profile.memory.activeProvider || t("settings.builtin")} />
            <label class="settings-field"><span>{t("settings.provider")}</span>
              <select value={providerDraft} disabled={!mutationAccess.memory || memoryBusy} onChange={(event) => setProviderDraft(event.currentTarget.value)}>
                <option value="">{t("settings.builtin")}</option>
                {profile.memory.providers.filter((provider) => provider.name !== "builtin").map((provider) => <option key={provider.name} value={provider.name}>{provider.name}{provider.configured ? "" : ` — ${t("settings.setupRequired")}`}</option>)}
              </select>
            </label>
            <ActionBar dirty={providerDraft !== profile.memory.activeProvider} busy={memoryBusy} permitted={mutationAccess.memory} onSave={saveProvider} />
          </div>
          {providerConfig && providerConfig.fields.some((field) => field.kind !== "secret") && (
            <div class="settings-ledger settings-ledger--wide">
              <SectionHead code="MEM-02" title={t("settings.providerSettings", { name: providerConfig.label })} note={`revision ${shortRevision(providerConfig.revision)}`} />
              <div class="provider-fields">
                {providerConfig.fields.filter((field) => field.kind !== "secret").map((field) => (
                  <label class="settings-field" key={field.key}>
                    <span>{field.label}{field.required ? " *" : ""}</span>
                    {field.kind === "boolean" ? (
                      <input type="checkbox" checked={providerValues[field.key] === true} disabled={!mutationAccess.memory || memoryBusy} onChange={(event) => setProviderValues({ ...providerValues, [field.key]: event.currentTarget.checked })} />
                    ) : field.kind === "select" ? (
                      <select value={String(providerValues[field.key] ?? "")} disabled={!mutationAccess.memory || memoryBusy} onChange={(event) => setProviderValues({ ...providerValues, [field.key]: event.currentTarget.value })}>
                        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    ) : (
                      <input value={String(providerValues[field.key] ?? "")} disabled={!mutationAccess.memory || memoryBusy} onInput={(event) => setProviderValues({ ...providerValues, [field.key]: event.currentTarget.value })} />
                    )}
                    {field.description && <small>{field.description}</small>}
                  </label>
                ))}
              </div>
              <ActionBar dirty={providerConfigDirty} busy={memoryBusy} permitted={mutationAccess.memory} onSave={saveProviderConfig} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SectionHead({ code, title, note, info }: { code: string; title: string; note?: string; info?: string }) {
  return (
    <header class="settings-section-head">
      <span>{code}</span>
      <div class="heading-info-group">
        <h2>{title}</h2>
        {info && <InfoTip text={info} align="end" />}
      </div>
      {note && <small>{note}</small>}
    </header>
  );
}

function SwitchRow({ label, detail, checked, disabled, onChange }: { label: string; detail: string; checked: boolean; disabled: boolean; onChange(value: boolean): void }) {
  return <label class="settings-switch"><span><b>{label} <InfoTip text={detail} align="start" /></b></span><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} /></label>;
}

function ActionBar({ dirty, retryPending = false, busy, permitted, valid = true, onSave }: { dirty: boolean; retryPending?: boolean; busy: boolean; permitted: boolean; valid?: boolean; onSave(): void }) {
  const actionable = dirty || retryPending;
  const status = !permitted ? t("settings.readOnly") : !valid ? t("settings.invalidBudget") : dirty ? t("settings.unsaved") : retryPending ? t("settings.retryRequired") : t("settings.upToDate");
  return <footer class="settings-actions"><span>{status}</span><button type="button" disabled={!permitted || !valid || !actionable || busy} onClick={onSave}>{busy ? t("settings.saving") : retryPending && !dirty ? t("settings.retrySync") : t("settings.save")}</button></footer>;
}

function SettingsSkeleton() {
  return <div class="settings-skeleton" aria-label={t("settings.loadingAria")}><i /><i /><i /><span>{t("settings.loading")}</span></div>;
}

function EmptyProfile({ onReload }: { onReload(): Promise<void> }) {
  return <div class="settings-empty settings-empty--profile"><b>{t("settings.selectProfile")}</b><p>{t("settings.selectProfileDetail")}</p><button type="button" onClick={() => void onReload()}>{t("settings.reload")}</button></div>;
}

function valuesFromConfig(config: MemoryProviderConfig): Record<string, boolean | string> {
  return Object.fromEntries(config.fields.filter((field) => field.kind !== "secret" && field.value !== undefined).map((field) => [field.key, field.value!])) as Record<string, boolean | string>;
}

function parseSkillLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
}

function errorState(reason: unknown): ErrorState {
  if (reason instanceof SettingsApiError) return { message: officeRuntimeMessage(reason.message), conflict: reason.kind === "conflict" };
  return { message: officeMessage("settings.loadFailed"), conflict: false };
}

function shortRevision(value: string): string { return value.slice(0, 8); }
function formatBytes(value: number): string { return value < 1_024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
