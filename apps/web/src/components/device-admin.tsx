import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { RemoteConfigStatus } from "@hermes-office/protocol";
import { fetchRemoteConfigStatus, revokeRemoteDevice, DeviceRevokeError, OfficeRemoteConfigError, type DeviceRevokeFailureCode, type RemoteConfigFailureCode } from "../office-api";
import { locale, t, type TranslationKey } from "../i18n";
import { InfoTip } from "./info-tip";
import "./access-audit.css";

const REVOKE_ERROR_KEY: Readonly<Record<DeviceRevokeFailureCode, TranslationKey>> = {
  not_found: "hostAdmin.revokeFailed.notFound",
  forbidden: "hostAdmin.revokeFailed.forbidden",
  unavailable: "hostAdmin.revokeFailed.unavailable",
  unknown: "hostAdmin.revokeFailed.unknown",
};

export function DeviceAdmin() {
  const [status, setStatus] = useState<RemoteConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<RemoteConfigFailureCode | null>(null);
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmDevice, setConfirmDevice] = useState<RemoteConfigStatus["devices"][number] | null>(null);
  const [revokeError, setRevokeError] = useState<DeviceRevokeFailureCode | null>(null);
  const [, setLocaleRevision] = useState(0);
  const generation = useRef(0);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const revokeTriggerRef = useRef<HTMLButtonElement | null>(null);

  const reload = useCallback(async (showLoading = true) => {
    const currentGeneration = ++generation.current;
    if (showLoading) setLoading(true);
    try {
      const next = await fetchRemoteConfigStatus();
      if (generation.current !== currentGeneration) return;
      setStatus(next);
      setError(null);
    } catch (reason) {
      if (generation.current !== currentGeneration) return;
      if (reason instanceof OfficeRemoteConfigError && (reason.status === 401 || reason.status === 403)) {
        setError("not_allowed");
      } else {
        setError("load_failed");
      }
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const unsubscribe = locale.subscribe(() => setLocaleRevision((value) => value + 1));
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [reload]);

  useEffect(() => {
    if (confirmDevice) cancelButtonRef.current?.focus();
  }, [confirmDevice]);

  useEffect(() => {
    if (!confirmDevice && revokeTriggerRef.current) {
      const trigger = revokeTriggerRef.current;
      revokeTriggerRef.current = null;
      requestAnimationFrame(() => trigger.focus());
    }
  }, [confirmDevice]);

  const askRevoke = useCallback((device: RemoteConfigStatus["devices"][number], trigger: EventTarget | null) => {
    setRevokeError(null);
    revokeTriggerRef.current = trigger instanceof HTMLButtonElement ? trigger : null;
    setConfirmDevice(device);
  }, []);

  const cancelRevoke = useCallback(() => {
    setConfirmDevice(null);
  }, []);

  const revoke = useCallback(async (device: RemoteConfigStatus["devices"][number]) => {
    if (revoking.has(device.id)) return;
    setRevokeError(null);
    setConfirmDevice(null);
    revokeTriggerRef.current = null;
    setRevoking((prev) => new Set([...prev, device.id]));
    try {
      await revokeRemoteDevice(device.id);
      await reload(false);
    } catch (reason) {
      setRevokeError(reason instanceof DeviceRevokeError ? reason.code : "unavailable");
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(device.id);
        return next;
      });
    }
  }, [reload, revoking]);

  const revokeErrorKey = revokeError ? REVOKE_ERROR_KEY[revokeError] : null;

  return (
    <section class="access-audit" aria-labelledby="device-admin-title" aria-busy={loading}>
      <header class="access-audit__gate">
        <div class="access-audit__title">
          <p>{t("hostAdmin.eyebrow")}</p>
          <div class="heading-info-group">
            <h2 id="device-admin-title">{t("hostAdmin.title")}</h2>
            <InfoTip text={t("hostAdmin.guide")} align="start" side="bottom" />
          </div>
        </div>
        <button type="button" onClick={() => void reload()} disabled={loading}>
          {loading ? t("audit.loading") : t("hostAdmin.reload")}
        </button>
      </header>

      {error === "not_allowed" ? (
        <div class="access-audit__message is-error" role="alert">
          <b>{t("hostAdmin.notAllowed")}</b>
        </div>
      ) : error === "load_failed" ? (
        <div class="access-audit__message is-error" role="alert">
          <b>{t("hostAdmin.loadFailed")}</b>
        </div>
      ) : status === null ? (
        <div class="access-audit__message">{t("audit.loading")}</div>
      ) : (
        <div class="access-audit__rail">
          <div class="access-audit__current">
            <span>{t("hostAdmin.status")}</span>
            <strong>{status.enabled ? t("hostAdmin.enabled") : t("hostAdmin.disabled")}</strong>
          </div>

          <div class="access-audit__current">
            <span>{t("hostAdmin.proxyHops")}</span>
            <strong>{status.trustedProxyHops}</strong>
          </div>

          <div class="access-audit__rail-head" aria-hidden="true">
            <span>{t("hostAdmin.origins")}</span>
          </div>
          {status.origins.length === 0 ? (
            <div class="access-audit__message">{t("hostAdmin.noOrigins")}</div>
          ) : (
            <ol aria-label={t("hostAdmin.origins")}>
              {status.origins.map((origin) => (
                <li key={origin}><code>{origin}</code></li>
              ))}
            </ol>
          )}

          <div class="access-audit__rail-head" aria-hidden="true">
            <span>{t("hostAdmin.devices")}</span>
          </div>
          {status.devices.length === 0 ? (
            <div class="access-audit__message">{t("hostAdmin.noDevices")}</div>
          ) : (
            <ol aria-label={t("hostAdmin.devices")}>
              {status.devices.map((device) => (
                <li key={device.id} class="access-audit__device">
                  <span>{device.displayName}</span>
                  <span class={device.revokedAt ? "is-error" : "is-local"}>
                    {device.revokedAt ? t("audit.outcome.denied") : device.lastSeenAt ? formatTime(device.lastSeenAt) : t("hostAdmin.neverSeen")}
                  </span>
                  <button
                    type="button"
                    disabled={revoking.has(device.id) || device.revokedAt !== undefined}
                    onClick={(event) => askRevoke(device, event.currentTarget)}
                    aria-label={t("hostAdmin.revokeAria", { name: device.displayName })}
                  >
                    {revoking.has(device.id) ? t("hostAdmin.revoking") : device.revokedAt ? t("hostAdmin.revokeDone") : t("hostAdmin.revoke")}
                  </button>
                </li>
              ))}
            </ol>
          )}

          {confirmDevice && (
            <div
              class="access-audit__message"
              role="group"
              aria-labelledby="revoke-confirm-title"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRevoke();
                }
              }}
            >
              <b id="revoke-confirm-title">{t("hostAdmin.revokeConfirm")}</b>
              <p>{t("hostAdmin.revokePrompt", { name: confirmDevice.displayName })}</p>
              <div class="access-audit__device">
                <button
                  type="button"
                  ref={cancelButtonRef}
                  onClick={cancelRevoke}
                >
                  {t("hostAdmin.revokeCancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void revoke(confirmDevice)}
                  disabled={revoking.has(confirmDevice.id)}
                >
                  {revoking.has(confirmDevice.id) ? t("hostAdmin.revoking") : t("hostAdmin.revoke")}
                </button>
              </div>
            </div>
          )}

          {revokeError && revokeErrorKey && (
            <div class="access-audit__message is-error" role="alert">
              <b>{t(revokeErrorKey)}</b>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat(locale.value === "ja" ? "ja-JP" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp)).replaceAll("/", ".");
}
