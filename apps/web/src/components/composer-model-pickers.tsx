import { useEffect, useRef, useState } from "preact/hooks";
import { t, type TranslationKey } from "../i18n";
import {
  CHAT_MODEL_FIXED_OPTIONS,
  CHAT_MODEL_MANUAL_PROVIDER,
  ChatModelCatalogError,
  chatModelName,
  chatModelProvider,
  chatModelReasoningEffort,
  fetchLiveChatModels,
  isManualChatModelProvider,
  modelSlashCommand,
  resolvedCreateModelPrefs,
  resolvedReasoningEffortForCreate,
  setChatModelSelection,
  REASONING_EFFORT_VALUES,
  type LiveChatModelOption,
  type LiveChatProviderOption,
} from "../chat-model-prefs";
import { applySessionModelPrefs, sendMessage } from "../store";

type ModelsState = "idle" | "loading" | "ready" | "error";
type OpenMenu = "provider" | "model" | "effort" | null;

/**
 * Compact provider/model pickers for the chat composer.
 * Clicking the current names opens a dropdown; advanced options stay in ChatModelPanel.
 */
export function ComposerModelPickers({
  profileId,
  sessionId,
  sessionProvider,
  sessionModel,
  canSend,
  onQueued,
  onOpenAdvanced,
}: {
  profileId: string;
  sessionId: string;
  sessionProvider?: string | undefined;
  sessionModel?: string | undefined;
  canSend: boolean;
  onQueued: () => void;
  onOpenAdvanced: () => void;
}) {
  const [open, setOpen] = useState<OpenMenu>(null);
  const [liveProviders, setLiveProviders] = useState<LiveChatProviderOption[]>([]);
  const [liveModels, setLiveModels] = useState<LiveChatModelOption[]>([]);
  const [modelsState, setModelsState] = useState<ModelsState>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);

  const prefProvider = chatModelProvider.value;
  const prefModel = chatModelName.value;
  const displayProvider = displayProviderLabel(sessionProvider, prefProvider, liveProviders);
  const displayModel = displayModelLabel(sessionModel, prefModel);
  const displayEffort = chatModelReasoningEffort.value || t("chat.model.reasoning.default");

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !rootRef.current?.contains(target)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    // Warm the catalog when the composer mounts so first open is fast.
    void loadCatalog(preferredProviderScope(prefProvider), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  async function loadCatalog(providerScope?: string, forceRefresh = false): Promise<void> {
    const generation = ++generationRef.current;
    setModelsState("loading");
    setError(undefined);
    try {
      const catalog = await fetchLiveChatModels(profileId, providerScope, { forceRefresh });
      if (generation !== generationRef.current) return;
      setLiveProviders(catalog.providers);
      setLiveModels(catalog.models);
      setModelsState("ready");
    } catch (reason) {
      if (generation !== generationRef.current) return;
      setLiveModels([]);
      if (providerScope === undefined) setLiveProviders([]);
      setModelsState("error");
      setError(catalogErrorMessage(reason));
    }
  }

  function applyMain(provider: string, model: string, effort: string): void {
    const efforts = reasoningEffortsFor(liveModels, provider, model, modelsState);
    const createPrefs = resolvedCreateModelPrefs({ provider, model, reasoningEffort: effort }, efforts);
    applySessionModelPrefs(sessionId, createPrefs.provider, createPrefs.model, createPrefs.reasoningEffort);
    const command = modelSlashCommand({ provider, model, reasoningEffort: createPrefs.reasoningEffort });
    if (command && canSend) sendMessage(sessionId, command);
    else if (command && !canSend) onQueued();
  }

  function pickProvider(value: string): void {
    if (value === "default") {
      setChatModelSelection("", "", "");
      applySessionModelPrefs(sessionId, "", "", "");
      setOpen(null);
      void loadCatalog(undefined, false);
      return;
    }
    if (value === CHAT_MODEL_MANUAL_PROVIDER) {
      // Free-form entry lives in the advanced panel.
      setChatModelSelection(CHAT_MODEL_MANUAL_PROVIDER, prefModel || "", "");
      setOpen(null);
      onOpenAdvanced();
      return;
    }
    setChatModelSelection(value, "", "");
    setOpen("model");
    void loadCatalog(value, false);
  }

  function pickModel(value: string): void {
    if (!value) return;
    if (value === "__manual__") {
      setOpen(null);
      onOpenAdvanced();
      return;
    }
    const provider = prefProvider && !isManualChatModelProvider(prefProvider) ? prefProvider : "";
    if (!provider) {
      // Model without provider: treat as free-form via advanced panel.
      setOpen(null);
      onOpenAdvanced();
      return;
    }
    const efforts = reasoningEffortsFor(liveModels, provider, value, modelsState);
    const effort = resolvedReasoningEffortForCreate(
      { provider, model: value, reasoningEffort: chatModelReasoningEffort.value },
      efforts,
    ) ?? "";
    setChatModelSelection(provider, value, effort);
    applyMain(provider, value, effort);
    setOpen(null);
  }

  async function openMenu(next: Exclude<OpenMenu, null>): Promise<void> {
    setOpen((current) => (current === next ? null : next));
    const scope = preferredProviderScope(prefProvider);
    if (modelsState === "idle" || modelsState === "error" || (next === "model" && scope)) {
      await loadCatalog(scope, false);
    }
  }

  const retainedProvider = prefProvider && !isManualChatModelProvider(prefProvider) ? prefProvider : "";
  const providerInLiveList = liveProviders.some((item) => item.id === retainedProvider);
  const modelInLiveList = liveModels.some((item) => item.id === prefModel);
  const showRetainedModel = Boolean(prefModel) && !modelInLiveList && !isManualChatModelProvider(prefProvider);

  return (
    <div class="composer-model-pickers" ref={rootRef}>
      <div class="composer-model-chip-row" role="group" aria-label={`${t("chat.provider.label")} / ${t("chat.model.label")}`}>
        <button
          type="button"
          class={`composer-model-chip ${open === "provider" ? "is-open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open === "provider"}
          aria-label={t("chat.model.picker.providerAria", { name: displayProvider })}
          title={`${t("chat.provider.label")}: ${displayProvider}`}
          onClick={() => void openMenu("provider")}
        >
          <span class="composer-model-chip-value">{displayProvider}</span>
          <span class="composer-model-chip-caret" aria-hidden="true">▾</span>
        </button>
        <button
          type="button"
          class={`composer-model-chip ${open === "model" ? "is-open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open === "model"}
          aria-label={t("chat.model.picker.modelAria", { name: displayModel })}
          title={`${t("chat.model.label")}: ${displayModel}`}
          onClick={() => void openMenu("model")}
        >
          <span class="composer-model-chip-value">{displayModel}</span>
          <span class="composer-model-chip-caret" aria-hidden="true">▾</span>
        </button>
        <button
          type="button"
          class={`composer-model-chip composer-model-chip--effort ${open === "effort" ? "is-open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open === "effort"}
          aria-label={`${t("chat.reasoning")}: ${displayEffort}`}
          title={`${t("chat.reasoning")}: ${displayEffort}`}
          onClick={() => setOpen((c) => c === "effort" ? null : "effort")}
        >
          <span class="composer-model-chip-value">{displayEffort}</span>
          <span class="composer-model-chip-caret" aria-hidden="true">▾</span>
        </button>
      </div>

      {open === "provider" && (
        <div class="composer-model-menu" role="listbox" aria-label={t("chat.provider.label")}>
          {modelsState === "loading" && <p class="composer-model-menu-status">{t("chat.model.loading")}</p>}
          {modelsState === "error" && error && <p class="composer-model-menu-status is-error">{error}</p>}
          <button
            type="button"
            role="option"
            aria-selected={!prefProvider}
            class={!prefProvider ? "is-selected" : undefined}
            onClick={() => pickProvider("default")}
          >
            {t(CHAT_MODEL_FIXED_OPTIONS[0].labelKey)}
          </button>
          {liveProviders.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={prefProvider === option.id}
              class={prefProvider === option.id ? "is-selected" : undefined}
              onClick={() => pickProvider(option.id)}
            >
              {option.active ? t("chat.model.providerActive", { label: option.label }) : option.label}
            </button>
          ))}
          {retainedProvider && !providerInLiveList && (
            <button
              type="button"
              role="option"
              aria-selected={prefProvider === retainedProvider}
              class={prefProvider === retainedProvider ? "is-selected" : undefined}
              onClick={() => pickProvider(retainedProvider)}
            >
              {retainedProvider}
            </button>
          )}
          <button
            type="button"
            role="option"
            aria-selected={isManualChatModelProvider(prefProvider)}
            class={isManualChatModelProvider(prefProvider) ? "is-selected" : undefined}
            onClick={() => pickProvider(CHAT_MODEL_MANUAL_PROVIDER)}
          >
            {t(CHAT_MODEL_FIXED_OPTIONS[1].labelKey)}
          </button>
          <button
            type="button"
            class="composer-model-menu-advanced"
            onClick={() => {
              setOpen(null);
              onOpenAdvanced();
            }}
          >
            {t("chat.model.advanced")}
          </button>
        </div>
      )}

      {open === "model" && (
        <div class="composer-model-menu" role="listbox" aria-label={t("chat.model.label")}>
          {modelsState === "loading" && <p class="composer-model-menu-status">{t("chat.model.loading")}</p>}
          {modelsState === "error" && error && <p class="composer-model-menu-status is-error">{error}</p>}
          {modelsState === "ready" && liveModels.length === 0 && (
            <p class="composer-model-menu-status">{t("chat.model.modelsEmpty")}</p>
          )}
          {liveModels.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={prefModel === option.id}
              class={prefModel === option.id ? "is-selected" : undefined}
              onClick={() => pickModel(option.id)}
            >
              {option.label}
            </button>
          ))}
          {showRetainedModel && (
            <button
              type="button"
              role="option"
              aria-selected
              class="is-selected"
              onClick={() => pickModel(prefModel)}
            >
              {prefModel}
            </button>
          )}
          <button type="button" role="option" onClick={() => pickModel("__manual__")}>
            {t("chat.model.custom")}
          </button>
          <button
            type="button"
            class="composer-model-menu-advanced"
            onClick={() => {
              setOpen(null);
              onOpenAdvanced();
            }}
          >
            {t("chat.model.advanced")}
          </button>
        </div>
      )}

      {open === "effort" && (
        <div class="composer-model-menu" role="listbox" aria-label={t("chat.reasoning")}>
          {REASONING_EFFORT_VALUES.map((value) => (
            <button
              key={value}
              type="button"
              role="option"
              aria-selected={chatModelReasoningEffort.value === value}
              class={chatModelReasoningEffort.value === value ? "is-selected" : undefined}
              onClick={() => {
                const provider = prefProvider && !isManualChatModelProvider(prefProvider) ? prefProvider : "";
                const model = prefModel || "";
                setChatModelSelection(provider, model, value);
                if (provider && model && canSend) {
                  applySessionModelPrefs(sessionId, provider, model, value);
                }
                setOpen(null);
              }}
            >
              {t(`chat.model.reasoning.${value}` as TranslationKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function preferredProviderScope(provider: string): string | undefined {
  return provider && !isManualChatModelProvider(provider) ? provider : undefined;
}

function displayProviderLabel(
  sessionProvider: string | undefined,
  prefProvider: string,
  liveProviders: readonly LiveChatProviderOption[],
): string {
  if (sessionProvider) {
    const live = liveProviders.find((item) => item.id === sessionProvider);
    return live?.label ?? sessionProvider;
  }
  if (!prefProvider || isManualChatModelProvider(prefProvider)) return t("chat.model.default");
  const live = liveProviders.find((item) => item.id === prefProvider);
  return live?.label ?? prefProvider;
}

function displayModelLabel(sessionModel: string | undefined, prefModel: string): string {
  if (sessionModel) return sessionModel;
  if (prefModel) return prefModel;
  return t("chat.model.default");
}

function reasoningEffortsFor(
  models: readonly LiveChatModelOption[],
  provider: string,
  model: string,
  state: ModelsState,
): readonly string[] | undefined {
  if (state !== "ready") return undefined;
  if (!provider || isManualChatModelProvider(provider) || !model) return undefined;
  const found = models.find((item) => item.id === model);
  const efforts = found?.reasoningEfforts;
  return efforts && efforts.length > 0 ? efforts : undefined;
}

function catalogErrorMessage(error: unknown): string {
  if (error instanceof ChatModelCatalogError) {
    const key = `chat.model.error.${error.code === "unavailable" ? "unavailable"
      : error.code === "not-found" ? "notFound"
        : error.code === "unauthorized" ? "unauthorized"
          : error.code === "invalid" ? "invalid"
            : "incompatible"}` as TranslationKey;
    return t(key);
  }
  return t("chat.model.error.unavailable");
}
