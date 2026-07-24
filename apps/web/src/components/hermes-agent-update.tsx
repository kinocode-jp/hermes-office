import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { HermesAgentUpdateStatus } from "@hermes-studio/protocol";
import { loadHermesAgentUpdateStatus, startHermesAgentUpdate } from "../hermes-agent-api";
import { locale, t, type TranslationKey } from "../i18n";
import { CheckIcon, RefreshIcon, UploadIcon } from "./icons";
import { InfoTip } from "./info-tip";
import "./host-apps.css";

const PHASE_LABELS: Record<HermesAgentUpdateStatus["phase"], TranslationKey> = {
  checking: "hermesUpdate.status.checking",
  up_to_date: "hermesUpdate.status.upToDate",
  available: "hermesUpdate.status.available",
  updating: "hermesUpdate.status.updating",
  updated: "hermesUpdate.status.updated",
  blocked: "hermesUpdate.status.blocked",
  failed: "hermesUpdate.status.failed",
  unsupported: "hermesUpdate.status.unsupported",
};

const FAILURE_LABELS: Record<NonNullable<HermesAgentUpdateStatus["failure"]>, TranslationKey> = {
  executable_missing: "hermesUpdate.failure.executableMissing",
  check_failed: "hermesUpdate.failure.checkFailed",
  update_failed: "hermesUpdate.failure.updateFailed",
  update_timeout: "hermesUpdate.failure.updateTimeout",
  unsupported_install: "hermesUpdate.failure.unsupportedInstall",
};

export function HermesAgentUpdate({ permitted }: { permitted: boolean }) {
  const [status, setStatus] = useState<HermesAgentUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const [, setLocaleRevision] = useState(0);

  const reload = useCallback(async (showLoading = true, force = false) => {
    const currentGeneration = ++generation.current;
    if (showLoading) setLoading(true);
    try {
      const next = await loadHermesAgentUpdateStatus({ force });
      if (generation.current !== currentGeneration) return;
      setStatus(next);
      setError(false);
    } catch {
      if (generation.current === currentGeneration) setError(true);
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const unsubscribe = locale.subscribe(() => setLocaleRevision((value) => value + 1));
    return () => { generation.current += 1; unsubscribe(); };
  }, [reload]);

  useEffect(() => {
    if (status?.phase !== "updating" && status?.phase !== "checking") return;
    const timer = globalThis.setInterval(() => void reload(false), 1_500);
    return () => globalThis.clearInterval(timer);
  }, [reload, status?.phase]);

  const beginUpdate = useCallback(async () => {
    if (!permitted || status?.canUpdate !== true || status.phase === "updating") return;
    if (!window.confirm(t("hermesUpdate.confirm"))) return;
    const currentGeneration = ++generation.current;
    setError(false);
    try {
      const next = await startHermesAgentUpdate();
      if (generation.current === currentGeneration) setStatus(next);
    } catch {
      if (generation.current === currentGeneration) setError(true);
    }
  }, [permitted, status]);

  const phase = status?.phase ?? "checking";
  const detail = status?.failure
    ? t(FAILURE_LABELS[status.failure])
    : phase === "updating" ? t("hermesUpdate.updatingDetail")
      : phase === "updated" ? t("hermesUpdate.updatedDetail")
        : phase === "available" ? t("hermesUpdate.availableDetail")
          : phase === "up_to_date" ? t("hermesUpdate.upToDateDetail")
            : phase === "checking" ? t("hermesUpdate.checkingDetail")
              : t("hermesUpdate.blockedDetail");

  const versionLabel = status?.currentVersion
    ? t("hermesUpdate.version", { version: status.currentVersion })
    : t("hermesUpdate.versionUnknown");

  return (
    <section class="host-apps" aria-labelledby="hermes-update-title" aria-busy={loading || phase === "updating" || phase === "checking"}>
      <header class="host-apps__header">
        <div>
          <span>{t("hermesUpdate.eyebrow")}</span>
          <h2 id="hermes-update-title">{t("hermesUpdate.title")}</h2>
        </div>
        <button
          type="button"
          onClick={() => void reload(true, true)}
          disabled={loading || phase === "updating"}
          aria-label={t("hermesUpdate.reload")}
          title={t("hermesUpdate.reload")}
        >
          <RefreshIcon />
        </button>
      </header>

      <article class={`host-apps__card is-${phase === "updated" || phase === "up_to_date" ? "installed" : phase === "updating" || phase === "checking" ? "installing" : phase === "failed" || phase === "blocked" || phase === "unsupported" ? "failed" : "available"}`}>
        <div class="host-apps__sigil" aria-hidden="true"><i /><i /><i /></div>
        <div class="host-apps__copy">
          <div class="host-apps__name-row">
            <h3>Hermes Agent</h3>
            <span class="host-apps__status">
              <i class="host-apps__status-dot" aria-hidden="true" />
              <InfoTip text={`${status ? t(PHASE_LABELS[status.phase]) : t("hermesUpdate.status.checking")} · ${detail}`} align="start" />
            </span>
          </div>
          <small>{versionLabel} · {t("hermesUpdate.method")}</small>
        </div>
        <div class="host-apps__action">
          {phase === "up_to_date" || phase === "updated" ? (
            <strong aria-label={t(PHASE_LABELS[phase])} title={t(PHASE_LABELS[phase])}><CheckIcon /></strong>
          ) : (
            <button
              type="button"
              onClick={() => void beginUpdate()}
              disabled={loading || !permitted || status?.canUpdate !== true || phase === "updating" || phase === "checking"}
              aria-label={phase === "updating" ? t("hermesUpdate.updating") : t("hermesUpdate.update")}
              title={phase === "updating" ? t("hermesUpdate.updating") : t("hermesUpdate.update")}
            >
              <UploadIcon />
            </button>
          )}
        </div>
      </article>

      {!permitted && <p class="host-apps__notice">{t("hermesUpdate.ownerRequired")}</p>}
      {error && <p class="host-apps__notice is-error" role="alert">{t("hermesUpdate.loadFailed")}</p>}
    </section>
  );
}
