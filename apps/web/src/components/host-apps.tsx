import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { HostAppStatus } from "@hermes-studio/protocol";
import { installObsidian, loadObsidianStatus } from "../host-apps-api";
import { locale, t, type TranslationKey } from "../i18n";
import "./host-apps.css";

const PHASE_LABELS: Record<HostAppStatus["phase"], TranslationKey> = {
  available: "hostApps.status.available",
  installing: "hostApps.status.installing",
  installed: "hostApps.status.installed",
  blocked: "hostApps.status.blocked",
  failed: "hostApps.status.failed",
  unsupported: "hostApps.status.unsupported",
};

const FAILURE_LABELS: Record<NonNullable<HostAppStatus["failure"]>, TranslationKey> = {
  homebrew_missing: "hostApps.failure.homebrewMissing",
  unsupported_platform: "hostApps.failure.unsupportedPlatform",
  install_failed: "hostApps.failure.installFailed",
  install_timeout: "hostApps.failure.installTimeout",
};

export function HostApps({ permitted }: { permitted: boolean }) {
  const [status, setStatus] = useState<HostAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const [, setLocaleRevision] = useState(0);

  const reload = useCallback(async (showLoading = true) => {
    const currentGeneration = ++generation.current;
    if (showLoading) setLoading(true);
    try {
      const next = await loadObsidianStatus();
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
    if (status?.phase !== "installing") return;
    const timer = globalThis.setInterval(() => void reload(false), 1_500);
    return () => globalThis.clearInterval(timer);
  }, [reload, status?.phase]);

  const beginInstall = useCallback(async () => {
    if (!permitted || status?.canInstall !== true || status.phase === "installing") return;
    if (!window.confirm(t("hostApps.installConfirm"))) return;
    const currentGeneration = ++generation.current;
    setError(false);
    try {
      const next = await installObsidian();
      if (generation.current === currentGeneration) setStatus(next);
    } catch {
      if (generation.current === currentGeneration) setError(true);
    }
  }, [permitted, status]);

  const phase = status?.phase ?? "available";
  const detail = status?.failure ? t(FAILURE_LABELS[status.failure])
    : phase === "installed" ? t("hostApps.installedDetail")
      : phase === "installing" ? t("hostApps.installingDetail")
        : t("hostApps.availableDetail");

  return (
    <section class="host-apps" aria-labelledby="host-apps-title" aria-busy={loading || phase === "installing"}>
      <header class="host-apps__header">
        <div>
          <span>{t("hostApps.eyebrow")}</span>
          <h2 id="host-apps-title">{t("hostApps.title")}</h2>
        </div>
        <button type="button" onClick={() => void reload()} disabled={loading}>{t("hostApps.reload")}</button>
      </header>

      <article class={`host-apps__card is-${phase}`}>
        <div class="host-apps__sigil" aria-hidden="true"><i /><i /><i /></div>
        <div class="host-apps__copy">
          <div class="host-apps__name-row">
            <h3>Obsidian</h3>
            <span>{status ? t(PHASE_LABELS[status.phase]) : t("hostApps.status.checking")}</span>
          </div>
          <p>{detail}</p>
          <small>{t("hostApps.method")}</small>
        </div>
        <div class="host-apps__action">
          {status?.installed ? (
            <strong aria-label={t("hostApps.status.installed")}>✓</strong>
          ) : (
            <button
              type="button"
              onClick={() => void beginInstall()}
              disabled={loading || !permitted || status?.canInstall !== true || phase === "installing"}
            >
              {phase === "installing" ? t("hostApps.installing") : t("hostApps.install")}
            </button>
          )}
        </div>
      </article>

      {!permitted && <p class="host-apps__notice">{t("hostApps.ownerRequired")}</p>}
      {error && <p class="host-apps__notice is-error" role="alert">{t("hostApps.loadFailed")}</p>}
    </section>
  );
}
