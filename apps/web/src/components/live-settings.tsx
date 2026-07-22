import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  GLOBAL_CONTEXT_MAX_UTF8_BYTES,
  GLOBAL_SETTINGS_MAX_SKILLS,
  globalContextUtf8Bytes,
  isGlobalContextWithinBudget,
} from "@hermes-studio/protocol";
import type { SettingsTab } from "../domain";
import { localizeRuntimeMessage, officeMessage, officeRuntimeMessage, t, type RuntimeMessage } from "../i18n";
import { isLocalOfficeClient } from "../auth-state";
import { canMutateSettingsTab, settingsMutationAccess } from "../settings-access";
import { preserveConcurrentDraft } from "../settings-draft";
import { SettingsMutationRegistry, type SettingsMutationScope } from "../settings-mutation-registry";
import { officeSnapshot } from "../store";
import { AccessAudit } from "./access-audit";
import { DeviceAdmin } from "./device-admin";
import { HostApps } from "./host-apps";
import { InfoTip } from "./info-tip";
import { depositSecretTransfer } from "../desktop-transport";
import {
  SettingsApiError,
  consumeSecretTransfer,
  loadAgentBehavior,
  loadBuiltinMemoryFiles,
  loadGlobalSettings,
  loadMemoryProviderConfig,
  loadPrivilegedProfileConfig,
  loadProfileHermesConfig,
  loadProfileSecrets,
  loadProfileSettings,
  loadUsageStats,
  resetBuiltinMemory,
  secretFieldDraftKey,
  setMemoryProvider,
  setSkillEnabled,
  updateAgentBehavior,
  updateBuiltinMemoryFile,
  updateGlobalSettings,
  updateMemoryProviderConfig,
  updatePrivilegedProfileConfig,
  updateProfileHermesConfig,
  updateProfileSoul,
  type BuiltinMemoryFiles,
  type GlobalAgentSettings,
  type HermesConfigValue,
  type HermesPrivilegedConfigValue,
  type HermesSecretFieldMeta,
  type MemoryProviderConfig,
  type MemoryResetTarget,
  type ProfileAgentBehavior,
  type ProfileAgentSettings,
  type ProfileHermesConfig,
  type ProfilePrivilegedHermesConfig,
  type ProfileSecrets,
  type UsageStatItem,
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
  onChanged?: (kind: "global" | "memory" | "skill" | "soul" | "agent-behavior" | "config" | "privileged-config" | "secret") => void;
};

type ErrorState = { message: RuntimeMessage; conflict: boolean };

export function LiveSettings({ profileId, profileLabel, initialTab = "global", activeTab, showAccessAudit = false, showHostAdmin = false, onTabChange, onChanged }: LiveSettingsProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const visibleTab = activeTab ?? tab;
  const [global, setGlobal] = useState<GlobalAgentSettings | null>(null);
  const [profile, setProfile] = useState<ProfileAgentSettings | null>(null);
  const [agentBehavior, setAgentBehavior] = useState<ProfileAgentBehavior | null>(null);
  const [providerConfig, setProviderConfig] = useState<MemoryProviderConfig | null>(null);
  const [memoryFiles, setMemoryFiles] = useState<BuiltinMemoryFiles | null>(null);
  const [globalContext, setGlobalContext] = useState("");
  const [globalSkills, setGlobalSkills] = useState("");
  const [sharedContext, setSharedContext] = useState(true);
  const [sharedSkills, setSharedSkills] = useState(true);
  const [soulDraft, setSoulDraft] = useState("");
  const [subagentAuto, setSubagentAuto] = useState(false);
  const [preferredSubagent, setPreferredSubagent] = useState("");
  const [providerDraft, setProviderDraft] = useState("");
  const [providerValues, setProviderValues] = useState<Record<string, boolean | string>>({});
  const [memoryDraft, setMemoryDraft] = useState("");
  const [userDraft, setUserDraft] = useState("");
  const [resetTarget, setResetTarget] = useState<MemoryResetTarget>("all");
  const [skillQuery, setSkillQuery] = useState("");
  const [skillLimit, setSkillLimit] = useState(30);
  const [usageBySkill, setUsageBySkill] = useState<ReadonlyMap<string, UsageStatItem>>(() => new Map());
  const [hermesConfig, setHermesConfig] = useState<ProfileHermesConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, HermesConfigValue>>({});
  const [configQuery, setConfigQuery] = useState("");
  const [configCategory, setConfigCategory] = useState<string>("");
  /** Isolated from the shared settings error so Advanced config outages do not block other tabs. */
  const [configError, setConfigError] = useState<ErrorState | null>(null);
  const [privilegedConfig, setPrivilegedConfig] = useState<ProfilePrivilegedHermesConfig | null>(null);
  const [privilegedDraft, setPrivilegedDraft] = useState<Record<string, HermesPrivilegedConfigValue>>({});
  const [privilegedQuery, setPrivilegedQuery] = useState("");
  const [privilegedCategory, setPrivilegedCategory] = useState<string>("");
  const [privilegedError, setPrivilegedError] = useState<ErrorState | null>(null);
  const [profileSecrets, setProfileSecrets] = useState<ProfileSecrets | null>(null);
  /** Write-only secret drafts keyed by source:key — never persisted after save. */
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [secretError, setSecretError] = useState<ErrorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<ErrorState | null>(null);
  const generation = useRef(0);
  const mutations = useRef(new SettingsMutationRegistry());
  const snapshot = officeSnapshot.value;
  const mutationAccess = settingsMutationAccess(snapshot);
  const canReadAudit = snapshot?.capabilities.access.allowedOperations.includes("audit.read") === true;
  const hostAdmin = showHostAdmin && mutationAccess.hostAdmin;
  // Remote devices need the host/device tab for session logout (not revoke).
  const showDeviceAdmin = hostAdmin || (showHostAdmin && !isLocalOfficeClient(location));
  // Stable scalar for reload deps: avoid stale canLoadMemoryBodies after capability changes.
  const canLoadMemoryBodies = mutationAccess.memory;
  const canLoadPrivileged = mutationAccess.privileged;

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
    setConfigError(null);
    setProviderConfig(null);
    setMemoryFiles(null);
    setMemoryDraft("");
    setUserDraft("");
    setHermesConfig(null);
    setConfigDraft({});
    setPrivilegedConfig(null);
    setPrivilegedDraft({});
    setPrivilegedError(null);
    setProfileSecrets(null);
    setSecretDrafts({});
    setSecretError(null);
    // Raw MEMORY.md / USER.md bodies require memory.update (local/step-up).
    // Capacity + provider status stay on state.read and must keep loading here.
    // Advanced config is isolated: a missing/failing Hermes config endpoint
    // must not make Global/Skills/Identity/Memory unusable.
    // Privileged + secrets only load on desktop-capability owner sessions.
    try {
      const [nextGlobal, nextProfile, nextUsage, nextBehavior, nextMemoryFiles, nextConfigResult, nextPrivilegedResult, nextSecretsResult] = await Promise.all([
        loadGlobalSettings(),
        profileId ? loadProfileSettings(profileId) : Promise.resolve(null),
        profileId ? loadUsageStats(profileId, 30).catch(() => null) : Promise.resolve(null),
        profileId ? loadAgentBehavior(profileId) : Promise.resolve(null),
        profileId && canLoadMemoryBodies ? loadBuiltinMemoryFiles(profileId) : Promise.resolve(null),
        profileId
          ? loadProfileHermesConfig(profileId).then(
            (config) => ({ ok: true as const, config }),
            (reason: unknown) => ({ ok: false as const, reason }),
          )
          : Promise.resolve({ ok: true as const, config: null }),
        profileId && canLoadPrivileged
          ? loadPrivilegedProfileConfig(profileId).then(
            (config) => ({ ok: true as const, config }),
            (reason: unknown) => ({ ok: false as const, reason }),
          )
          : Promise.resolve({ ok: true as const, config: null }),
        profileId && canLoadPrivileged
          ? loadProfileSecrets(profileId).then(
            (secrets) => ({ ok: true as const, secrets }),
            (reason: unknown) => ({ ok: false as const, reason }),
          )
          : Promise.resolve({ ok: true as const, secrets: null }),
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
      setMemoryFiles(nextMemoryFiles);
      setMemoryDraft(nextMemoryFiles?.memory.content ?? "");
      setUserDraft(nextMemoryFiles?.user.content ?? "");
      const skillUsage = new Map<string, UsageStatItem>();
      for (const item of nextUsage?.items ?? []) {
        if (item.kind === "skill") skillUsage.set(item.name, item);
      }
      setUsageBySkill(skillUsage);
      setAgentBehavior(nextBehavior);
      setSubagentAuto(nextBehavior?.subagentMode === "auto");
      setPreferredSubagent(nextBehavior?.preferredSubagent ?? "");
      if (nextConfigResult.ok) {
        setHermesConfig(nextConfigResult.config);
        setConfigDraft(nextConfigResult.config ? { ...nextConfigResult.config.values } : {});
        setConfigError(null);
        if (nextConfigResult.config && nextConfigResult.config.categories.length > 0) {
          setConfigCategory((current) =>
            current && nextConfigResult.config!.categories.includes(current)
              ? current
              : nextConfigResult.config!.categories[0]!,
          );
        }
      } else {
        setHermesConfig(null);
        setConfigDraft({});
        setConfigError(errorState(nextConfigResult.reason));
      }
      if (nextPrivilegedResult.ok) {
        setPrivilegedConfig(nextPrivilegedResult.config);
        setPrivilegedDraft(nextPrivilegedResult.config ? { ...nextPrivilegedResult.config.values } : {});
        setPrivilegedError(null);
        if (nextPrivilegedResult.config && nextPrivilegedResult.config.categories.length > 0) {
          setPrivilegedCategory((current) =>
            current && nextPrivilegedResult.config!.categories.includes(current)
              ? current
              : nextPrivilegedResult.config!.categories[0]!,
          );
        }
      } else {
        setPrivilegedConfig(null);
        setPrivilegedDraft({});
        setPrivilegedError(errorState(nextPrivilegedResult.reason));
      }
      if (nextSecretsResult.ok) {
        setProfileSecrets(nextSecretsResult.secrets);
        setSecretDrafts({});
        setSecretError(null);
      } else {
        setProfileSecrets(null);
        setSecretDrafts({});
        setSecretError(errorState(nextSecretsResult.reason));
      }
      if (nextProfile) await loadProvider(nextProfile.profile, nextProfile.memory.activeProvider, currentGeneration);
    } catch (reason) {
      if (generation.current === currentGeneration) setError(errorState(reason));
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [canLoadMemoryBodies, canLoadPrivileged, loadProvider, profileId]);

  useEffect(() => {
    if (visibleTab === "host") {
      generation.current += 1;
      setLoading(false);
      setError(null);
      setGlobal(null);
      setProfile(null);
      setUsageBySkill(new Map());
      setAgentBehavior(null);
      setProviderConfig(null);
      setProviderValues({});
      setMemoryFiles(null);
      setSoulDraft("");
      setSubagentAuto(false);
      setPreferredSubagent("");
      setProviderDraft("");
      setMemoryDraft("");
      setUserDraft("");
      setHermesConfig(null);
      setConfigDraft({});
      setConfigError(null);
      setPrivilegedConfig(null);
      setPrivilegedDraft({});
      setPrivilegedError(null);
      setProfileSecrets(null);
      setSecretDrafts({});
      setSecretError(null);
      return;
    }
    void reload();
    return () => { generation.current += 1; };
  }, [reload, visibleTab]);

  useEffect(() => { setSkillLimit(30); }, [profileId, skillQuery]);

  const perform = useCallback(async (
    key: string,
    scope: SettingsMutationScope,
    action: () => Promise<void>,
    kind: "global" | "memory" | "skill" | "soul" | "agent-behavior" | "config" | "privileged-config" | "secret",
  ) => {
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

  const saveAgentBehavior = () => {
    if (!profile || !agentBehavior || !mutationAccess.soul) return;
    const submitted = { subagentAuto, preferredSubagent };
    void perform("agent-behavior", "agent-behavior", async () => {
      const updated = await updateAgentBehavior(profile.profile, {
        expectedRevision: agentBehavior.revision,
        subagentMode: submitted.subagentAuto ? "auto" : "manual",
        preferredSubagent: submitted.preferredSubagent,
      });
      setAgentBehavior(updated);
      setSubagentAuto((current) => preserveConcurrentDraft(current, submitted.subagentAuto, updated.subagentMode === "auto"));
      setPreferredSubagent((current) => preserveConcurrentDraft(current, submitted.preferredSubagent, updated.preferredSubagent));
    }, "agent-behavior");
  };

  const saveHermesConfig = () => {
    if (!profile || !hermesConfig || !mutationAccess.config) return;
    const changes = collectConfigChanges(hermesConfig.values, configDraft);
    if (Object.keys(changes).length === 0) return;
    const submitted = { ...configDraft };
    // Capture target + generation so a late response cannot overwrite a newer profile.
    // expectedRevision is still the revision observed at submit time (server 409 on stale).
    const targetProfile = profile.profile;
    const expectedRevision = hermesConfig.revision;
    const requestGeneration = generation.current;
    void perform("hermes-config", "config", async () => {
      const updated = await updateProfileHermesConfig(targetProfile, {
        expectedRevision,
        changes,
      });
      if (generation.current !== requestGeneration) return;
      setHermesConfig(updated);
      setConfigError(null);
      setConfigDraft((current) => {
        // Keep concurrent local edits that were not part of this save.
        // Revision-based conflict remains on the server (HTTP 409).
        const next = { ...updated.values };
        for (const [key, value] of Object.entries(current)) {
          if (!(key in changes) && JSON.stringify(value) !== JSON.stringify(submitted[key])) {
            next[key] = value;
          }
        }
        return next;
      });
    }, "config");
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

  const saveMemoryFile = (key: "memory" | "user") => {
    if (!profile || !memoryFiles || !mutationAccess.memory) return;
    const submittedDraft = key === "memory" ? memoryDraft : userDraft;
    const expectedRevision = key === "memory" ? memoryFiles.memory.revision : memoryFiles.user.revision;
    void perform(`memory-file:${key}`, "memory", async () => {
      const updated = await updateBuiltinMemoryFile(profile.profile, key, submittedDraft, expectedRevision);
      setMemoryFiles((current) => current === null ? current : { ...current, [key]: updated });
      if (key === "memory") {
        setMemoryDraft((current) => preserveConcurrentDraft(current, submittedDraft, updated.content));
      } else {
        setUserDraft((current) => preserveConcurrentDraft(current, submittedDraft, updated.content));
      }
      setProfile((current) => {
        if (current === null) return current;
        const builtin = { ...current.memory.builtin };
        if (key === "memory") {
          builtin.memoryBytes = updated.bytes;
          builtin.hasMemory = updated.exists && updated.bytes > 0;
        } else {
          builtin.userBytes = updated.bytes;
          builtin.hasUser = updated.exists && updated.bytes > 0;
        }
        return { ...current, memory: { ...current.memory, builtin } };
      });
    }, "memory");
  };

  const confirmResetMemory = () => {
    if (!profile || !mutationAccess.memory) return;
    const label = resetTarget === "all"
      ? t("settings.memoryReset.targetAll")
      : resetTarget === "memory"
        ? "MEMORY.md"
        : "USER.md";
    if (!window.confirm(t("settings.memoryReset.confirm", { target: label }))) return;
    void perform("memory-reset", "memory", async () => {
      const result = await resetBuiltinMemory(profile.profile, resetTarget);
      setMemoryFiles(result.files);
      setMemoryDraft(result.files.memory.content);
      setUserDraft(result.files.user.content);
      setProfile((current) => current === null ? current : { ...current, memory: result.status });
    }, "memory");
  };

  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase();
    if (!query) return profile?.skills ?? [];
    return (profile?.skills ?? []).filter((skill) => `${skill.name} ${skill.description} ${skill.category}`.toLocaleLowerCase().includes(query));
  }, [profile, skillQuery]);
  const visibleSkills = filteredSkills.slice(0, skillLimit);
  const filteredConfigFields = useMemo(() => {
    if (!hermesConfig) return [];
    const query = configQuery.trim().toLocaleLowerCase();
    return hermesConfig.fields.filter((field) => {
      if (configCategory && field.category !== configCategory) return false;
      if (!query) return true;
      return `${field.id} ${field.description} ${field.category}`.toLocaleLowerCase().includes(query);
    });
  }, [configCategory, configQuery, hermesConfig]);
  const configDirtyCount = useMemo(() => {
    if (!hermesConfig) return 0;
    return Object.keys(collectConfigChanges(hermesConfig.values, configDraft)).length;
  }, [configDraft, hermesConfig]);

  /** Reload Advanced config only. Never discards local drafts without confirmation. */
  const reloadHermesConfig = () => {
    if (!profileId) return;
    if (configDirtyCount > 0) {
      if (!window.confirm(t("settings.configDiscardConfirm"))) return;
    }
    // Dedicated busy key; failures stay on configError so other Settings tabs remain usable.
    if (!mutations.current.start("hermes-config-reload", "config")) return;
    setBusy(mutations.current.snapshot());
    // Capture before the request: profile switch / full reload advances generation.
    // A late success must not overwrite the new profile; a late failure must not clear it.
    const targetProfile = profileId;
    const requestGeneration = generation.current;
    void (async () => {
      try {
        const updated = await loadProfileHermesConfig(targetProfile);
        if (generation.current !== requestGeneration) return;
        setHermesConfig(updated);
        setConfigDraft({ ...updated.values });
        setConfigError(null);
        if (updated.categories.length > 0) {
          setConfigCategory((current) =>
            current && updated.categories.includes(current) ? current : updated.categories[0]!,
          );
        }
      } catch (reason) {
        if (generation.current !== requestGeneration) return;
        setHermesConfig(null);
        setConfigDraft({});
        setConfigError(errorState(reason));
      } finally {
        // Always release the busy key even when the response is ignored as stale.
        mutations.current.finish("hermes-config-reload");
        setBusy(mutations.current.snapshot());
      }
    })();
  };

  /** Explicit discard of local Advanced drafts back to the last loaded revision. */
  const discardHermesConfigDraft = () => {
    if (!hermesConfig || configDirtyCount === 0) return;
    if (!window.confirm(t("settings.configDiscardConfirm"))) return;
    setConfigDraft({ ...hermesConfig.values });
  };

  const filteredPrivilegedFields = useMemo(() => {
    if (!privilegedConfig) return [];
    const query = privilegedQuery.trim().toLocaleLowerCase();
    return privilegedConfig.fields.filter((field) => {
      if (privilegedCategory && field.category !== privilegedCategory) return false;
      if (!query) return true;
      return `${field.id} ${field.description} ${field.category}`.toLocaleLowerCase().includes(query);
    });
  }, [privilegedCategory, privilegedConfig, privilegedQuery]);

  const privilegedDirtyCount = useMemo(() => {
    if (!privilegedConfig) return 0;
    return Object.keys(collectConfigChanges(privilegedConfig.values, privilegedDraft)).length;
  }, [privilegedConfig, privilegedDraft]);

  const reloadPrivilegedConfig = () => {
    if (!profileId || !mutationAccess.privileged) return;
    if (privilegedDirtyCount > 0) {
      if (!window.confirm(t("settings.privileged.discardConfirm"))) return;
    }
    if (!mutations.current.start("privileged-config-reload", "privileged")) return;
    setBusy(mutations.current.snapshot());
    const targetProfile = profileId;
    const requestGeneration = generation.current;
    void (async () => {
      try {
        const [updated, secrets] = await Promise.all([
          loadPrivilegedProfileConfig(targetProfile),
          loadProfileSecrets(targetProfile),
        ]);
        if (generation.current !== requestGeneration) return;
        setPrivilegedConfig(updated);
        setPrivilegedDraft({ ...updated.values });
        setPrivilegedError(null);
        setProfileSecrets(secrets);
        setSecretDrafts({});
        setSecretError(null);
        if (updated.categories.length > 0) {
          setPrivilegedCategory((current) =>
            current && updated.categories.includes(current) ? current : updated.categories[0]!,
          );
        }
      } catch (reason) {
        if (generation.current !== requestGeneration) return;
        setPrivilegedConfig(null);
        setPrivilegedDraft({});
        setPrivilegedError(errorState(reason));
      } finally {
        mutations.current.finish("privileged-config-reload");
        setBusy(mutations.current.snapshot());
      }
    })();
  };

  const discardPrivilegedDraft = () => {
    if (!privilegedConfig || privilegedDirtyCount === 0) return;
    if (!window.confirm(t("settings.privileged.discardConfirm"))) return;
    setPrivilegedDraft({ ...privilegedConfig.values });
  };

  const savePrivilegedConfig = () => {
    if (!profileId || !privilegedConfig || !mutationAccess.privileged) return;
    const changes = collectConfigChanges(privilegedConfig.values, privilegedDraft);
    const keys = Object.keys(changes);
    if (keys.length === 0) return;
    const needsConfirm = keys.some((key) => {
      const field = privilegedConfig.fields.find((item) => item.id === key);
      return field?.requiresConfirmation === true;
    });
    if (needsConfirm && !window.confirm(t("settings.privileged.confirmSave"))) return;
    const expectedRevision = privilegedConfig.revision;
    const submitted = { ...privilegedDraft };
    const targetProfile = profileId;
    const requestGeneration = generation.current;
    void perform("privileged-config", "privileged", async () => {
      const updated = await updatePrivilegedProfileConfig(targetProfile, {
        expectedRevision,
        changes,
        ...(needsConfirm ? { confirmed: true as const } : {}),
      });
      if (generation.current !== requestGeneration) return;
      setPrivilegedConfig(updated);
      setPrivilegedError(null);
      setPrivilegedDraft((current) => {
        const next = { ...updated.values };
        for (const [key, value] of Object.entries(current)) {
          if (!(key in changes) && JSON.stringify(value) !== JSON.stringify(submitted[key])) {
            next[key] = value;
          }
        }
        return next;
      });
    }, "privileged-config");
  };

  const secretConfirmLabel = (field: HermesSecretFieldMeta): string =>
    field.source === "memory-provider"
      ? `${field.providerLabel || field.provider || "provider"} / ${field.label || field.key}`
      : (field.label || field.key);

  const submitSecretTransfer = (
    field: HermesSecretFieldMeta,
    value: string,
    confirmMessage: string,
  ) => {
    if (!profileId || !profileSecrets || !mutationAccess.privileged) return;
    if (!window.confirm(confirmMessage)) return;
    const draftKey = secretFieldDraftKey(field);
    const targetProfile = profileId;
    const expectedRevision = profileSecrets.revision;
    const requestGeneration = generation.current;
    void perform(`secret:${draftKey}`, "secret", async () => {
      // Secret bytes (including empty clear) go through Tauri IPC only.
      // Browser fetch carries transferId + field metadata, never the value.
      let transferId: string;
      try {
        transferId = await depositSecretTransfer(value);
      } finally {
        // Write-only control stays blank after every deposit attempt.
        setSecretDrafts((current) => {
          const next = { ...current };
          delete next[draftKey];
          return next;
        });
      }
      const updated = await consumeSecretTransfer(targetProfile, {
        transferId,
        key: field.key,
        source: field.source,
        ...(field.provider === undefined ? {} : { provider: field.provider }),
        expectedRevision,
      });
      if (generation.current !== requestGeneration) return;
      setProfileSecrets(updated);
      setSecretError(null);
      setSecretDrafts({});
    }, "secret");
  };

  const saveSecretField = (field: HermesSecretFieldMeta) => {
    if (!profileId || !profileSecrets || !mutationAccess.privileged) return;
    const draftKey = secretFieldDraftKey(field);
    const value = secretDrafts[draftKey] ?? "";
    // Blank input is a no-op for ordinary Save (use Clear to unset).
    if (value === "") return;
    submitSecretTransfer(
      field,
      value,
      t("settings.privileged.secretConfirm", { key: secretConfirmLabel(field) }),
    );
  };

  const clearSecretField = (field: HermesSecretFieldMeta) => {
    if (!profileId || !profileSecrets || !mutationAccess.privileged) return;
    // canClear is a UI hint only; server recomputes clear safety.
    if (!field.isSet || !field.canClear) return;
    submitSecretTransfer(
      field,
      "",
      t("settings.privileged.secretClearConfirm", { key: secretConfirmLabel(field) }),
    );
  };

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
  const agentBehaviorDirty = agentBehavior !== null && (
    (agentBehavior.subagentMode === "auto") !== subagentAuto
    || agentBehavior.preferredSubagent !== preferredSubagent
  );
  const providerConfigDirty = providerConfig !== null && JSON.stringify(providerValues) !== JSON.stringify(valuesFromConfig(providerConfig));
  const memoryFileDirty = memoryFiles !== null && memoryFiles.memory.content !== memoryDraft;
  const userFileDirty = memoryFiles !== null && memoryFiles.user.content !== userDraft;
  const memoryBusy = busy.has("provider") || busy.has("provider-config")
    || busy.has("memory-file:memory") || busy.has("memory-file:user") || busy.has("memory-reset");

  return (
    <section class="live-settings" aria-busy={loading}>
      <header class="live-settings__mast">
        <div>
          <h1>{t("settings.title")}</h1>
        </div>
        {visibleTab !== "host" && (
          <div class="live-settings__target">
            <span>{t("settings.target")}</span>
            <b>{profileName}</b>
          </div>
        )}
      </header>

      {showAccessAudit && canReadAudit && <AccessAudit />}

      {visibleTab !== "host" && !currentTabWritable && (
        <div class="live-settings__notice is-read-only" role="status">
          <span>{t("settings.readOnly")}</span>
          <p>{mutationAccess.localOwner ? t("settings.permissionUnavailable") : t("settings.localOwnerRequired")}</p>
        </div>
      )}

      <nav class="live-settings__tabs" aria-label={t("settings.categories")}>
        {([
          ["global", t("settings.global")],
          ["skills", t("settings.skills")],
          ["soul", t("settings.identity")],
          ["memory", t("settings.memory")],
          ["config", t("settings.config")],
          ["privileged", t("settings.privileged")],
          ...(showDeviceAdmin ? [["host", t("hostAdmin.title")] as const] : []),
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
        showDeviceAdmin && (
          <>
            <HostApps permitted={mutationAccess.hostApps} />
            <DeviceAdmin />
          </>
        )
      ) : visibleTab === "global" ? (
        <div class="live-settings__global">
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
          <p class="settings-global-lead">{t("settings.inherit")}</p>
          <div class="settings-ledger">
            <SectionHead title={t("settings.inheritance")} note={`revision ${global?.revision ?? "—"}`} />
            <SwitchRow label={t("settings.sharedSkills")} detail={t("settings.sharedSkillsDetail")} checked={sharedSkills} disabled={!mutationAccess.global} onChange={setSharedSkills} />
            <SwitchRow label={t("settings.sharedContext")} detail={t("settings.sharedContextDetail")} checked={sharedContext} disabled={!mutationAccess.global} onChange={setSharedContext} />
          </div>
          <div class="settings-global-stack">
            <div class="settings-ledger">
              <SectionHead title={t("settings.globalSkills")} note={t("settings.onePerLine")} />
              <textarea value={globalSkills} onInput={(event) => setGlobalSkills(event.currentTarget.value)} rows={7} spellcheck={false} disabled={!mutationAccess.global} aria-invalid={!globalSkillsValid} placeholder={"browser\ncoding\nresearch"} />
              <small class={`settings-budget ${globalSkillsValid ? "" : "is-over"}`}>{t("settings.skillBudget", { count: parsedGlobalSkills.length, max: GLOBAL_SETTINGS_MAX_SKILLS })}</small>
            </div>
            <div class="settings-ledger">
              <SectionHead title={t("settings.sharedContext")} info={t("settings.noSecrets")} />
              <textarea value={globalContext} onInput={(event) => setGlobalContext(event.currentTarget.value)} rows={8} disabled={!mutationAccess.global} aria-invalid={!globalContextValid} aria-describedby="global-context-budget" placeholder={t("settings.contextPlaceholder")} />
              <small id="global-context-budget" class={`settings-budget ${globalContextValid ? "" : "is-over"}`}>{t("settings.contextBudget", { count: globalContextBytes, max: GLOBAL_CONTEXT_MAX_UTF8_BYTES })}</small>
            </div>
          </div>
          <div class="settings-ledger settings-ledger--actions">
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
                <div>
                  <b>{skill.name}</b>
                  <p>{skill.description || t("settings.noDescription")}</p>
                  <span class="skill-line__usage">{skillUsageLabel(skill.usage, usageBySkill.get(skill.name))}</span>
                </div>
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
        <div class="live-settings__soul">
          <div class="settings-ledger settings-ledger--editor">
            <SectionHead title={`${profile.profile} / SOUL.md`} note={`revision ${shortRevision(profile.soul.revision)}`} info={t("settings.soulNote")} />
            {profile.soul.redacted && <p class="settings-warning">{t("settings.redacted")}</p>}
            <textarea value={soulDraft} onInput={(event) => setSoulDraft(event.currentTarget.value)} rows={18} disabled={profile.soul.redacted || !mutationAccess.soul} spellcheck={false} />
            <ActionBar dirty={soulDirty && !profile.soul.redacted} busy={busy.has("soul")} permitted={mutationAccess.soul} onSave={saveSoul} />
          </div>
          {agentBehavior && (
            <div class="settings-ledger">
              <SectionHead
                title={t("settings.subagents.title")}
                note={`revision ${agentBehavior.revision}`}
                info={t("settings.subagents.note")}
              />
              <SwitchRow
                label={t("settings.subagents.auto")}
                detail={t("settings.subagents.autoDetail")}
                checked={subagentAuto}
                disabled={!mutationAccess.soul}
                onChange={setSubagentAuto}
              />
              <label class="settings-field">
                <span>{t("settings.subagents.preferred")}</span>
                <input
                  type="text"
                  value={preferredSubagent}
                  disabled={!mutationAccess.soul}
                  placeholder={t("settings.subagents.preferredPlaceholder")}
                  spellcheck={false}
                  onInput={(event) => setPreferredSubagent(event.currentTarget.value)}
                />
              </label>
              <ActionBar dirty={agentBehaviorDirty} busy={busy.has("agent-behavior")} permitted={mutationAccess.soul} onSave={saveAgentBehavior} />
            </div>
          )}
        </div>
      ) : visibleTab === "privileged" ? (
        <div class="live-settings__config live-settings__privileged">
          <p class="settings-global-lead">{t("settings.privileged.lead")}</p>
          <div class="live-settings__notice is-read-only" role="note">
            <span>{t("settings.privileged.desktopOnlyTitle")}</span>
            <p>{t("settings.privileged.desktopOnlyNote")}</p>
          </div>
          {!mutationAccess.privileged ? (
            <div class="live-settings__notice is-read-only" role="status">
              <span>{t("settings.privileged.unavailableTitle")}</span>
              <p>{t("settings.privileged.unavailableDetail")}</p>
            </div>
          ) : (
            <>
              <div class="live-settings__notice is-read-only" role="note">
                <span>{t("settings.privileged.applyTitle")}</span>
                <p>{t("settings.privileged.applyNote")}</p>
              </div>
              {privilegedError && (
                <div class={`live-settings__notice ${privilegedError.conflict ? "is-conflict" : "is-error"}`} role="alert">
                  <span>{privilegedError.conflict ? t("settings.conflict") : t("settings.privileged.unavailableTitle")}</span>
                  <p>{localizeRuntimeMessage(privilegedError.message)}</p>
                  <button
                    type="button"
                    disabled={busy.has("privileged-config-reload") || busy.has("privileged-config")}
                    onClick={() => reloadPrivilegedConfig()}
                  >
                    {busy.has("privileged-config-reload") ? t("settings.loading") : t("settings.privileged.reload")}
                  </button>
                </div>
              )}
              {!privilegedConfig ? (
                !privilegedError && <p class="settings-empty">{t("settings.privileged.unavailableTitle")}</p>
              ) : (
                <>
                  <div class="settings-toolbar settings-toolbar--config">
                    <div>
                      <b>{privilegedDirtyCount}</b>
                      <span>{t("settings.privileged.dirty", { count: privilegedDirtyCount })}</span>
                    </div>
                    <div class="settings-config-meta">
                      <small>revision {shortRevision(privilegedConfig.revision)}</small>
                      {privilegedConfig.unsupportedCount > 0 && (
                        <small>{t("settings.privileged.unsupported", { count: privilegedConfig.unsupportedCount })}</small>
                      )}
                      {privilegedConfig.secretFieldCount > 0 && (
                        <small>{t("settings.privileged.secretCount", { count: privilegedConfig.secretFieldCount })}</small>
                      )}
                    </div>
                    <div class="settings-config-toolbar-actions">
                      <button
                        type="button"
                        disabled={busy.has("privileged-config-reload") || busy.has("privileged-config")}
                        onClick={() => reloadPrivilegedConfig()}
                      >
                        {busy.has("privileged-config-reload") ? t("settings.loading") : t("settings.privileged.reload")}
                      </button>
                      <button
                        type="button"
                        disabled={privilegedDirtyCount === 0 || busy.has("privileged-config") || busy.has("privileged-config-reload")}
                        onClick={() => discardPrivilegedDraft()}
                      >
                        {t("settings.privileged.discard")}
                      </button>
                    </div>
                    <input
                      type="search"
                      value={privilegedQuery}
                      onInput={(event) => setPrivilegedQuery(event.currentTarget.value)}
                      placeholder={t("settings.privileged.search")}
                      aria-label={t("settings.privileged.search")}
                    />
                  </div>
                  <nav class="settings-config-categories" aria-label={t("settings.privileged.categories")}>
                    {privilegedConfig.categories.map((category) => (
                      <button
                        key={category}
                        type="button"
                        class={privilegedCategory === category ? "is-active" : ""}
                        onClick={() => setPrivilegedCategory(category)}
                      >
                        {category}
                      </button>
                    ))}
                  </nav>
                  <div class="settings-ledger settings-ledger--wide">
                    <SectionHead
                      title={privilegedCategory || t("settings.privileged")}
                      note={`${filteredPrivilegedFields.length} fields`}
                    />
                    <div class="provider-fields config-fields">
                      {filteredPrivilegedFields.map((field) => (
                        <PrivilegedFieldEditor
                          key={field.id}
                          field={field}
                          value={privilegedDraft[field.id] ?? privilegedConfig.values[field.id]}
                          disabled={!mutationAccess.privileged || busy.has("privileged-config") || busy.has("privileged-config-reload")}
                          onChange={(next) => setPrivilegedDraft((current) => ({ ...current, [field.id]: next }))}
                        />
                      ))}
                      {filteredPrivilegedFields.length === 0 && <p class="settings-empty">{t("settings.privileged.noFields")}</p>}
                    </div>
                    <ActionBar
                      dirty={privilegedDirtyCount > 0}
                      busy={busy.has("privileged-config") || busy.has("privileged-config-reload")}
                      permitted={mutationAccess.privileged}
                      onSave={savePrivilegedConfig}
                    />
                  </div>
                </>
              )}

              <div class="settings-ledger settings-ledger--wide">
                <SectionHead
                  title={t("settings.privileged.secretsTitle")}
                  note={profileSecrets ? `revision ${shortRevision(profileSecrets.revision)}` : "—"}
                  info={t("settings.privileged.secretsNote")}
                />
                {secretError && (
                  <div class={`live-settings__notice ${secretError.conflict ? "is-conflict" : "is-error"}`} role="alert">
                    <span>{secretError.conflict ? t("settings.conflict") : t("settings.privileged.secretsUnavailable")}</span>
                    <p>{localizeRuntimeMessage(secretError.message)}</p>
                  </div>
                )}
                {!profileSecrets ? (
                  !secretError && <p class="settings-empty">{t("settings.privileged.secretsUnavailable")}</p>
                ) : (
                  <div class="provider-fields config-fields secret-fields">
                    {profileSecrets.fields.map((field) => {
                      const draftKey = secretFieldDraftKey(field);
                      const busyKey = `secret:${draftKey}`;
                      const context = field.source === "memory-provider"
                        ? t("settings.privileged.secretMemoryProvider", {
                          provider: field.providerLabel || field.provider || "provider",
                        })
                        : field.source === "env"
                          ? t("settings.privileged.secretEnv")
                          : t("settings.privileged.secretConfig");
                      return (
                        <label class="settings-field" key={draftKey}>
                          <span title={field.key}>
                            {field.label || field.key}
                            <small class="secret-field-meta">
                              {context} · {field.isSet ? t("settings.privileged.secretIsSet") : t("settings.privileged.secretNotSet")}
                            </small>
                          </span>
                          <input
                            type="password"
                            autoComplete="off"
                            spellcheck={false}
                            value={secretDrafts[draftKey] ?? ""}
                            disabled={!mutationAccess.privileged || busy.has(busyKey)}
                            placeholder={t("settings.privileged.secretPlaceholder")}
                            onInput={(event) => {
                              const next = event.currentTarget.value;
                              setSecretDrafts((current) => ({ ...current, [draftKey]: next }));
                            }}
                          />
                          {field.description && <small>{field.description}</small>}
                          <div class="settings-secret-actions">
                            <button
                              type="button"
                              class="settings-secret-save"
                              disabled={
                                !mutationAccess.privileged
                                || busy.has(busyKey)
                                || !(secretDrafts[draftKey] ?? "")
                              }
                              onClick={() => saveSecretField(field)}
                            >
                              {busy.has(busyKey) ? t("settings.saving") : t("settings.privileged.secretSave")}
                            </button>
                            {field.canClear && (
                              <button
                                type="button"
                                class="settings-secret-clear"
                                disabled={
                                  !mutationAccess.privileged
                                  || busy.has(busyKey)
                                  || !field.isSet
                                }
                                onClick={() => clearSecretField(field)}
                              >
                                {busy.has(busyKey) ? t("settings.saving") : t("settings.privileged.secretClear")}
                              </button>
                            )}
                          </div>
                        </label>
                      );
                    })}
                    {profileSecrets.fields.length === 0 && (
                      <p class="settings-empty">{t("settings.privileged.noSecrets")}</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      ) : visibleTab === "config" ? (
        <div class="live-settings__config">
          <p class="settings-global-lead">{t("settings.configLead")}</p>
          <div class="live-settings__notice is-read-only" role="note">
            <span>{t("settings.configApplyTitle")}</span>
            <p>{t("settings.configApplyNote")}</p>
          </div>
          {configError && (
            <div class={`live-settings__notice ${configError.conflict ? "is-conflict" : "is-error"}`} role="alert">
              <span>{configError.conflict ? t("settings.conflict") : t("settings.configUnavailable")}</span>
              <p>{localizeRuntimeMessage(configError.message)}</p>
              <button
                type="button"
                disabled={busy.has("hermes-config-reload") || busy.has("hermes-config")}
                onClick={() => reloadHermesConfig()}
              >
                {busy.has("hermes-config-reload") ? t("settings.loading") : t("settings.configReload")}
              </button>
            </div>
          )}
          {!hermesConfig ? (
            !configError && <p class="settings-empty">{t("settings.configUnavailable")}</p>
          ) : (
            <>
              <div class="settings-toolbar settings-toolbar--config">
                <div>
                  <b>{configDirtyCount}</b>
                  <span>{t("settings.configDirty", { count: configDirtyCount })}</span>
                </div>
                <div class="settings-config-meta">
                  <small>revision {shortRevision(hermesConfig.revision)}</small>
                  {hermesConfig.excludedCount > 0 && (
                    <small>{t("settings.configExcluded", { count: hermesConfig.excludedCount })}</small>
                  )}
                </div>
                <div class="settings-config-toolbar-actions">
                  <button
                    type="button"
                    disabled={busy.has("hermes-config-reload") || busy.has("hermes-config")}
                    onClick={() => reloadHermesConfig()}
                  >
                    {busy.has("hermes-config-reload") ? t("settings.loading") : t("settings.configReload")}
                  </button>
                  <button
                    type="button"
                    disabled={configDirtyCount === 0 || busy.has("hermes-config") || busy.has("hermes-config-reload")}
                    onClick={() => discardHermesConfigDraft()}
                  >
                    {t("settings.configDiscard")}
                  </button>
                </div>
                <input
                  type="search"
                  value={configQuery}
                  onInput={(event) => setConfigQuery(event.currentTarget.value)}
                  placeholder={t("settings.configSearch")}
                  aria-label={t("settings.configSearch")}
                />
              </div>
              <nav class="settings-config-categories" aria-label={t("settings.configCategories")}>
                {hermesConfig.categories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    class={configCategory === category ? "is-active" : ""}
                    onClick={() => setConfigCategory(category)}
                  >
                    {category}
                  </button>
                ))}
              </nav>
              <div class="settings-ledger settings-ledger--wide">
                <SectionHead
                  title={configCategory || t("settings.config")}
                  note={`${filteredConfigFields.length} fields`}
                />
                <div class="provider-fields config-fields">
                  {filteredConfigFields.map((field) => (
                    <ConfigFieldEditor
                      key={field.id}
                      field={field}
                      value={configDraft[field.id] ?? hermesConfig.values[field.id]}
                      disabled={!mutationAccess.config || busy.has("hermes-config") || busy.has("hermes-config-reload")}
                      onChange={(next) => setConfigDraft((current) => ({ ...current, [field.id]: next }))}
                    />
                  ))}
                  {filteredConfigFields.length === 0 && <p class="settings-empty">{t("settings.configNoFields")}</p>}
                </div>
                <ActionBar
                  dirty={configDirtyCount > 0}
                  busy={busy.has("hermes-config") || busy.has("hermes-config-reload")}
                  permitted={mutationAccess.config}
                  onSave={saveHermesConfig}
                />
              </div>
            </>
          )}
        </div>
      ) : (
        <div class="live-settings__memory">
          <div class="memory-gauge">
            <p>{t("settings.builtinMemory")} <InfoTip text={t("settings.memoryNote")} align="start" /></p>
            <div>
              <span><b>{formatBytes(memoryFiles?.memory.bytes ?? profile.memory.builtin.memoryBytes)}</b>MEMORY.md</span>
              <i />
              <span><b>{formatBytes(memoryFiles?.user.bytes ?? profile.memory.builtin.userBytes)}</b>USER.md</span>
            </div>
            <small>{t("settings.memoryApplyNote")}</small>
          </div>
          <div class="settings-ledger">
            <SectionHead title={t("settings.memoryProvider")} note={profile.memory.activeProvider || t("settings.builtin")} />
            <label class="settings-field"><span>{t("settings.provider")}</span>
              <select value={providerDraft} disabled={!mutationAccess.memory || memoryBusy} onChange={(event) => setProviderDraft(event.currentTarget.value)}>
                <option value="">{t("settings.builtin")}</option>
                {profile.memory.providers.filter((provider) => provider.name !== "builtin").map((provider) => <option key={provider.name} value={provider.name}>{provider.name}{provider.configured ? "" : ` — ${t("settings.setupRequired")}`}</option>)}
              </select>
            </label>
            <ActionBar dirty={providerDraft !== profile.memory.activeProvider} busy={memoryBusy} permitted={mutationAccess.memory} onSave={saveProvider} />
          </div>
          <div class="settings-ledger settings-ledger--editor settings-ledger--memory-file">
            <SectionHead
              title="MEMORY.md"
              note={memoryFiles ? `revision ${shortRevision(memoryFiles.memory.revision)}` : "—"}
              info={t("settings.memoryFileNote")}
            />
            <textarea
              value={memoryDraft}
              onInput={(event) => setMemoryDraft(event.currentTarget.value)}
              rows={12}
              disabled={!mutationAccess.memory || memoryFiles === null || memoryBusy}
              spellcheck={false}
              aria-label="MEMORY.md"
            />
            <ActionBar
              dirty={memoryFileDirty}
              busy={busy.has("memory-file:memory")}
              permitted={mutationAccess.memory && memoryFiles !== null}
              onSave={() => saveMemoryFile("memory")}
            />
          </div>
          <div class="settings-ledger settings-ledger--editor settings-ledger--memory-file">
            <SectionHead
              title="USER.md"
              note={memoryFiles ? `revision ${shortRevision(memoryFiles.user.revision)}` : "—"}
              info={t("settings.userFileNote")}
            />
            <textarea
              value={userDraft}
              onInput={(event) => setUserDraft(event.currentTarget.value)}
              rows={12}
              disabled={!mutationAccess.memory || memoryFiles === null || memoryBusy}
              spellcheck={false}
              aria-label="USER.md"
            />
            <ActionBar
              dirty={userFileDirty}
              busy={busy.has("memory-file:user")}
              permitted={mutationAccess.memory && memoryFiles !== null}
              onSave={() => saveMemoryFile("user")}
            />
          </div>
          <div class="settings-ledger settings-ledger--memory-reset">
            <SectionHead title={t("settings.memoryReset.title")} info={t("settings.memoryReset.note")} />
            <label class="settings-field">
              <span>{t("settings.memoryReset.target")}</span>
              <select
                value={resetTarget}
                disabled={!mutationAccess.memory || memoryBusy}
                onChange={(event) => setResetTarget(event.currentTarget.value as MemoryResetTarget)}
              >
                <option value="all">{t("settings.memoryReset.targetAll")}</option>
                <option value="memory">MEMORY.md</option>
                <option value="user">USER.md</option>
              </select>
            </label>
            <footer class="settings-actions">
              <span>{t("settings.memoryReset.destructive")}</span>
              <button
                type="button"
                class="settings-actions__danger"
                disabled={!mutationAccess.memory || memoryBusy}
                onClick={confirmResetMemory}
              >
                {busy.has("memory-reset") ? t("settings.memoryReset.resetting") : t("settings.memoryReset.action")}
              </button>
            </footer>
          </div>
          {providerConfig && providerConfig.fields.some((field) => field.kind !== "secret") && (
            <div class="settings-ledger settings-ledger--wide">
              <SectionHead title={t("settings.providerSettings", { name: providerConfig.label })} note={`revision ${shortRevision(providerConfig.revision)}`} />
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

function SectionHead({ title, note, info }: { title: string; note?: string; info?: string }) {
  return (
    <header class="settings-section-head">
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
  return <div class="settings-empty settings-empty--profile"><b>{t("settings.selectProfile")}</b><button type="button" onClick={() => void onReload()}>{t("settings.reload")}</button></div>;
}

function valuesFromConfig(config: MemoryProviderConfig): Record<string, boolean | string> {
  return Object.fromEntries(config.fields.filter((field) => field.kind !== "secret" && field.value !== undefined).map((field) => [field.key, field.value!])) as Record<string, boolean | string>;
}

function parseSkillLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
}

function collectConfigChanges<T>(
  baseline: Record<string, T>,
  draft: Record<string, T>,
): Record<string, T> {
  const changes: Record<string, T> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (JSON.stringify(value) !== JSON.stringify(baseline[key])) changes[key] = value;
  }
  return changes;
}

function ConfigFieldEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ProfileHermesConfig["fields"][number];
  value: HermesConfigValue | undefined;
  disabled: boolean;
  onChange(value: HermesConfigValue): void;
}) {
  return (
    <label class="settings-field">
      <span title={field.id}>{field.id}</span>
      {field.type === "boolean" ? (
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      ) : field.type === "select" ? (
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
          {typeof value === "string" && value !== "" && !field.options.some((option) => option.value === value) && (
            <option value={value}>{value}</option>
          )}
        </select>
      ) : field.type === "number" ? (
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          disabled={disabled}
          onInput={(event) => {
            const next = event.currentTarget.value;
            if (next.trim() === "") return;
            const parsed = Number(next);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
        />
      ) : field.type === "list" ? (
        // Server projects string-lists only. Never coerce boolean/number rows via String().
        <ListFieldEditor
          value={asStringList(value)}
          disabled={disabled}
          onChange={(items) => onChange(items)}
        />
      ) : (
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          spellcheck={false}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
      )}
      {field.description && <small>{field.description}</small>}
    </label>
  );
}

function PrivilegedFieldEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ProfilePrivilegedHermesConfig["fields"][number];
  value: HermesPrivilegedConfigValue | undefined;
  disabled: boolean;
  onChange(value: HermesPrivilegedConfigValue): void;
}) {
  const impactLabel = field.impact === "restart"
    ? t("settings.privileged.impactRestart")
    : field.impact === "destructive"
      ? t("settings.privileged.impactDestructive")
      : t("settings.privileged.impactNewSession");
  return (
    <label class="settings-field">
      <span title={field.id}>
        {field.id}
        <small class="privileged-field-impact">{impactLabel}</small>
      </span>
      {field.type === "boolean" ? (
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      ) : field.type === "select" ? (
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
          {typeof value === "string" && value !== "" && !field.options.some((option) => option.value === value) && (
            <option value={value}>{value}</option>
          )}
        </select>
      ) : field.type === "number" ? (
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          disabled={disabled}
          onInput={(event) => {
            const next = event.currentTarget.value;
            if (next.trim() === "") return;
            const parsed = Number(next);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
        />
      ) : field.type === "list" ? (
        <ListFieldEditor
          value={asStringList(value as HermesConfigValue | undefined)}
          disabled={disabled}
          onChange={(items) => onChange(items)}
        />
      ) : field.type === "json" ? (
        <JsonFieldEditor
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          spellcheck={false}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
      )}
      {field.description && <small>{field.description}</small>}
    </label>
  );
}

function JsonFieldEditor({
  value,
  disabled,
  onChange,
}: {
  value: HermesPrivilegedConfigValue | undefined;
  disabled: boolean;
  onChange(value: HermesPrivilegedConfigValue): void;
}) {
  const [text, setText] = useState(() => stableJsonText(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(stableJsonText(value));
    setInvalid(false);
  }, [value]);
  return (
    <div class="config-json-editor">
      <textarea
        value={text}
        disabled={disabled}
        spellcheck={false}
        rows={6}
        aria-invalid={invalid}
        onInput={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          try {
            const parsed = JSON.parse(next) as unknown;
            setInvalid(false);
            onChange(parsed);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && <small class="settings-budget is-over">{t("settings.privileged.jsonInvalid")}</small>}
    </div>
  );
}

function stableJsonText(value: HermesPrivilegedConfigValue | undefined): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return "null";
  }
}

/** Fail closed: only pass through string[] values; never map(String) scalars. */
function asStringList(value: HermesConfigValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  if (!value.every((item): item is string => typeof item === "string")) return [];
  return value;
}

function ListFieldEditor({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange(value: string[]): void;
}) {
  return (
    <div class="config-list-editor">
      {value.map((item, index) => (
        <div class="config-list-row" key={`row-${index}`}>
          <input
            type="text"
            value={item}
            disabled={disabled}
            spellcheck={false}
            onInput={(event) => {
              const next = [...value];
              next[index] = event.currentTarget.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            disabled={disabled}
            aria-label={t("settings.configListRemove")}
            onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        class="config-list-add"
        disabled={disabled || value.length >= 64}
        onClick={() => onChange([...value, ""])}
      >
        {t("settings.configListAdd")}
      </button>
    </div>
  );
}

function errorState(reason: unknown): ErrorState {
  if (reason instanceof SettingsApiError) return { message: officeRuntimeMessage(reason.message), conflict: reason.kind === "conflict" };
  return { message: officeMessage("settings.loadFailed"), conflict: false };
}

function shortRevision(value: string): string { return value.slice(0, 8); }
function formatBytes(value: number): string { return value < 1_024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }

/** Compact monospace usage line: Office day stats when present, else Hermes cumulative-only. */
function skillUsageLabel(hermesUsage: number, office: UsageStatItem | undefined): string {
  if (office !== undefined) {
    const date = formatUsageDate(office.lastUsedAt);
    const line = t("settings.usage.stats", { total: office.total, period: office.periodCount, date });
    if (hermesUsage > 0 && hermesUsage !== office.total) {
      return `${line} · ${t("settings.usage.hermes", { count: hermesUsage })}`;
    }
    return line;
  }
  if (hermesUsage > 0) return t("settings.usage.hermesOnly", { count: hermesUsage });
  return t("settings.usage.none");
}

function formatUsageDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return t("settings.usage.unknownDate");
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return iso.slice(0, 10);
  }
}
