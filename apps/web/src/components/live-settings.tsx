import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SettingsTab } from "../domain";
import { AccessAudit } from "./access-audit";
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
  onTabChange?: (tab: SettingsTab) => void;
  onChanged?: (kind: "global" | "memory" | "skill" | "soul") => void;
};

type ErrorState = { message: string; conflict: boolean };

export function LiveSettings({ profileId, profileLabel, initialTab = "global", activeTab, showAccessAudit = false, onTabChange, onChanged }: LiveSettingsProps) {
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const generation = useRef(0);

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
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);

  useEffect(() => { setSkillLimit(30); }, [profileId, skillQuery]);

  const perform = useCallback(async (key: string, action: () => Promise<void>, kind: "global" | "memory" | "skill" | "soul") => {
    setBusy(key);
    setError(null);
    try {
      await action();
      onChanged?.(kind);
    } catch (reason) {
      setError(errorState(reason));
    } finally {
      setBusy(null);
    }
  }, [onChanged]);

  const saveGlobal = () => {
    if (!global) return;
    void perform("global", async () => {
      const updated = await updateGlobalSettings({
        expectedRevision: global.revision,
        sharedContextEnabled: sharedContext,
        sharedSkillsEnabled: sharedSkills,
        context: globalContext,
        skills: parseSkillLines(globalSkills),
      });
      setGlobal(updated);
      setGlobalContext(updated.context);
      setGlobalSkills(updated.skills.join("\n"));
    }, "global");
  };

  const toggleSkill = (name: string, enabled: boolean) => {
    if (!profile) return;
    void perform(`skill:${name}`, async () => {
      await setSkillEnabled(profile.profile, name, !enabled, enabled);
      setProfile((current) => current === null ? current : {
        ...current,
        skills: current.skills.map((skill) => skill.name === name ? { ...skill, enabled: !enabled } : skill),
      });
    }, "skill");
  };

  const saveSoul = () => {
    if (!profile || profile.soul.redacted) return;
    void perform("soul", async () => {
      const updated = await updateProfileSoul(profile.profile, soulDraft, profile.soul.revision);
      setProfile((current) => current === null ? current : { ...current, soul: updated });
      setSoulDraft(updated.content);
    }, "soul");
  };

  const saveProvider = () => {
    if (!profile || providerDraft === profile.memory.activeProvider) return;
    void perform("provider", async () => {
      const memory = await setMemoryProvider(profile.profile, providerDraft, profile.memory.activeProvider);
      setProfile((current) => current === null ? current : { ...current, memory });
      const currentGeneration = generation.current;
      await loadProvider(profile.profile, memory.activeProvider, currentGeneration);
    }, "memory");
  };

  const saveProviderConfig = () => {
    if (!profile || !providerConfig) return;
    void perform("provider-config", async () => {
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

  const profileName = profileLabel || profile?.profile || profileId || "Profile未選択";
  const globalDirty = global !== null && (
    global.context !== globalContext ||
    global.skills.join("\n") !== parseSkillLines(globalSkills).join("\n") ||
    global.sharedContextEnabled !== sharedContext ||
    global.sharedSkillsEnabled !== sharedSkills
  );
  const soulDirty = profile !== null && profile.soul.content !== soulDraft;
  const providerConfigDirty = providerConfig !== null && JSON.stringify(providerValues) !== JSON.stringify(valuesFromConfig(providerConfig));

  return (
    <section class="live-settings" aria-busy={loading}>
      <header class="live-settings__mast">
        <div>
          <p>BUILDING SYSTEMS / LIVE</p>
          <h1>Agent settings</h1>
        </div>
        <div class="live-settings__target">
          <span>Target profile</span>
          <b>{profileName}</b>
        </div>
      </header>

      {showAccessAudit && <AccessAudit />}

      <nav class="live-settings__tabs" aria-label="設定カテゴリ">
        {([
          ["global", "Global"],
          ["skills", "Skills"],
          ["soul", "Identity / SOUL"],
          ["memory", "Memory"],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" class={visibleTab === id ? "is-active" : ""} aria-current={visibleTab === id ? "page" : undefined} onClick={() => { setTab(id); onTabChange?.(id); }} disabled={id !== "global" && !profileId}>
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <div class={`live-settings__notice ${error.conflict ? "is-conflict" : "is-error"}`} role="alert">
          <span>{error.conflict ? "REVISION CONFLICT" : "SETTINGS OFFLINE"}</span>
          <p>{error.message}</p>
          <button type="button" onClick={() => void reload()}>再読込</button>
        </div>
      )}

      {loading && !global ? (
        <SettingsSkeleton />
      ) : visibleTab === "global" ? (
        <div class="live-settings__grid live-settings__global">
          {global?.skillSync.state === "pending" && (
            <div class="live-settings__notice is-conflict settings-sync-notice" role="status">
              <span>SKILL SYNC PENDING</span>
              <p>一部ProfileへのGlobal Skill反映が完了していません。再読込後に同じ内容を保存すると再試行できます。</p>
              <div class="settings-sync-failures" aria-label="未反映のGlobal Skill">
                {global.skillSync.failures.slice(0, 5).map((failure) => (
                  <small key={`${failure.profile}-${failure.skill}-${failure.operation}`}>{failure.profile} / {failure.skill} / {failure.operation}</small>
                ))}
              </div>
            </div>
          )}
          <aside class="inheritance-bus" aria-label="Global inheritance bus">
            <span>GLOBAL BUS</span><i /><b>Profiles inherit from here</b>
          </aside>
          <div class="settings-ledger">
            <SectionHead code="UTIL-01" title="Inheritance switches" note={`revision ${global?.revision ?? "—"}`} />
            <SwitchRow label="Shared skills" detail="Global skill selectionを各Profileへ継承" checked={sharedSkills} onChange={setSharedSkills} />
            <SwitchRow label="Shared context" detail="新しく開始するSessionへ共通文脈を適用" checked={sharedContext} onChange={setSharedContext} />
          </div>
          <div class="settings-ledger">
            <SectionHead code="UTIL-02" title="Global skills" note="1行に1つ" />
            <textarea value={globalSkills} onInput={(event) => setGlobalSkills(event.currentTarget.value)} rows={7} spellcheck={false} placeholder={"browser\ncoding\nresearch"} />
          </div>
          <div class="settings-ledger settings-ledger--wide">
            <SectionHead code="UTIL-03" title="Shared context" note="秘密情報は保存できません" />
            <textarea value={globalContext} onInput={(event) => setGlobalContext(event.currentTarget.value)} rows={8} placeholder="全Profileに共通する方針を書きます。" />
            <ActionBar dirty={globalDirty} retryPending={global?.skillSync.state === "pending"} busy={busy === "global"} onSave={saveGlobal} />
          </div>
        </div>
      ) : !profile ? (
        <EmptyProfile onReload={reload} />
      ) : visibleTab === "skills" ? (
        <div class="live-settings__skills">
          <div class="settings-toolbar">
            <div><b>{profile.skills.filter((skill) => skill.enabled).length}</b><span>enabled / {profile.skills.length} available</span></div>
            <input type="search" value={skillQuery} onInput={(event) => setSkillQuery(event.currentTarget.value)} placeholder="Skillを絞り込む" aria-label="Skillを絞り込む" />
          </div>
          <div class="skill-switchboard">
            {visibleSkills.map((skill) => (
              <article class={`skill-line ${skill.enabled ? "is-enabled" : ""}`} key={skill.name}>
                <span class="skill-line__light" aria-hidden="true" />
                <div><b>{skill.name}</b><p>{skill.description || "説明なし"}</p></div>
                <small>{skill.provenance} · {skill.category}</small>
                <button type="button" role="switch" aria-checked={skill.enabled} disabled={busy === `skill:${skill.name}`} onClick={() => toggleSkill(skill.name, skill.enabled)}>
                  {busy === `skill:${skill.name}` ? "…" : skill.enabled ? "ON" : "OFF"}
                </button>
              </article>
            ))}
            {filteredSkills.length === 0 && <p class="settings-empty">一致するSkillはありません。</p>}
            {filteredSkills.length > visibleSkills.length && (
              <button class="settings-load-more" type="button" onClick={() => setSkillLimit((current) => current + 30)}>
                さらに表示（残り {filteredSkills.length - visibleSkills.length}）
              </button>
            )}
          </div>
        </div>
      ) : visibleTab === "soul" ? (
        <div class="settings-ledger settings-ledger--editor">
          <SectionHead code="IDENTITY" title={`${profile.profile} / SOUL.md`} note={`revision ${shortRevision(profile.soul.revision)}`} />
          {profile.soul.redacted && <p class="settings-warning">非表示の機密らしき内容があります。上書きせず、Hermes側で確認してください。</p>}
          <textarea value={soulDraft} onInput={(event) => setSoulDraft(event.currentTarget.value)} rows={18} disabled={profile.soul.redacted} spellcheck={false} />
          <p class="settings-footnote">保存内容は新しいSessionから反映されます。進行中の会話は書き換えません。</p>
          <ActionBar dirty={soulDirty && !profile.soul.redacted} busy={busy === "soul"} onSave={saveSoul} />
        </div>
      ) : (
        <div class="live-settings__memory">
          <div class="memory-gauge">
            <p>BUILT-IN MEMORY</p>
            <div><span><b>{formatBytes(profile.memory.builtin.memoryBytes)}</b>MEMORY.md</span><i /><span><b>{formatBytes(profile.memory.builtin.userBytes)}</b>USER.md</span></div>
            <small>この画面では内容の直接編集・resetは行いません。</small>
          </div>
          <div class="settings-ledger">
            <SectionHead code="MEM-01" title="Memory provider" note={profile.memory.activeProvider || "built-in"} />
            <label class="settings-field"><span>Provider</span>
              <select value={providerDraft} onChange={(event) => setProviderDraft(event.currentTarget.value)}>
                <option value="">Built-in</option>
                {profile.memory.providers.filter((provider) => provider.name !== "builtin").map((provider) => <option key={provider.name} value={provider.name}>{provider.name}{provider.configured ? "" : " — setup required"}</option>)}
              </select>
            </label>
            <ActionBar dirty={providerDraft !== profile.memory.activeProvider} busy={busy === "provider"} onSave={saveProvider} />
          </div>
          {providerConfig && providerConfig.fields.some((field) => field.kind !== "secret") && (
            <div class="settings-ledger settings-ledger--wide">
              <SectionHead code="MEM-02" title={`${providerConfig.label} settings`} note={`revision ${shortRevision(providerConfig.revision)}`} />
              <div class="provider-fields">
                {providerConfig.fields.filter((field) => field.kind !== "secret").map((field) => (
                  <label class="settings-field" key={field.key}>
                    <span>{field.label}{field.required ? " *" : ""}</span>
                    {field.kind === "boolean" ? (
                      <input type="checkbox" checked={providerValues[field.key] === true} onChange={(event) => setProviderValues({ ...providerValues, [field.key]: event.currentTarget.checked })} />
                    ) : field.kind === "select" ? (
                      <select value={String(providerValues[field.key] ?? "")} onChange={(event) => setProviderValues({ ...providerValues, [field.key]: event.currentTarget.value })}>
                        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    ) : (
                      <input value={String(providerValues[field.key] ?? "")} onInput={(event) => setProviderValues({ ...providerValues, [field.key]: event.currentTarget.value })} />
                    )}
                    {field.description && <small>{field.description}</small>}
                  </label>
                ))}
              </div>
              <ActionBar dirty={providerConfigDirty} busy={busy === "provider-config"} onSave={saveProviderConfig} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SectionHead({ code, title, note }: { code: string; title: string; note: string }) {
  return <header class="settings-section-head"><span>{code}</span><h2>{title}</h2><small>{note}</small></header>;
}

function SwitchRow({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange(value: boolean): void }) {
  return <label class="settings-switch"><span><b>{label}</b><small>{detail}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} /></label>;
}

function ActionBar({ dirty, retryPending = false, busy, onSave }: { dirty: boolean; retryPending?: boolean; busy: boolean; onSave(): void }) {
  const actionable = dirty || retryPending;
  return <footer class="settings-actions"><span>{dirty ? "UNSAVED CHANGES" : retryPending ? "SYNC RETRY REQUIRED" : "UP TO DATE"}</span><button type="button" disabled={!actionable || busy} onClick={onSave}>{busy ? "保存中…" : retryPending && !dirty ? "同期を再試行" : "変更を保存"}</button></footer>;
}

function SettingsSkeleton() {
  return <div class="settings-skeleton" aria-label="設定を読み込み中"><i /><i /><i /><span>Hermes設定を読み込んでいます…</span></div>;
}

function EmptyProfile({ onReload }: { onReload(): Promise<void> }) {
  return <div class="settings-empty settings-empty--profile"><b>Profileを選択してください</b><p>Profile固有のSkills、SOUL、Memory設定がここに表示されます。</p><button type="button" onClick={() => void onReload()}>再読込</button></div>;
}

function valuesFromConfig(config: MemoryProviderConfig): Record<string, boolean | string> {
  return Object.fromEntries(config.fields.filter((field) => field.kind !== "secret" && field.value !== undefined).map((field) => [field.key, field.value!])) as Record<string, boolean | string>;
}

function parseSkillLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
}

function errorState(reason: unknown): ErrorState {
  if (reason instanceof SettingsApiError) return { message: reason.message, conflict: reason.kind === "conflict" };
  return { message: "設定を読み込めませんでした。", conflict: false };
}

function shortRevision(value: string): string { return value.slice(0, 8); }
function formatBytes(value: number): string { return value < 1_024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
