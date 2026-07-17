import { useEffect, useState } from "preact/hooks";
import { authenticateRemoteDevice } from "../office-api";
import { locale, localizeRuntimeMessage, setLocale, t } from "../i18n";
import { InfoTip } from "./info-tip";
import {
  officeAccess,
  retryOfficeServer,
  setDeviceLoginFailure,
  setDeviceLoginSubmitting
} from "../store";
import { classifyDeviceLoginFailure, shouldShowDeviceEnrollmentForm } from "../auth-state";

export function DeviceLogin() {
  const access = officeAccess.value;
  const [retrySeconds, setRetrySeconds] = useState(access.retryAfterSeconds ?? 0);

  useEffect(() => {
    setRetrySeconds(access.retryAfterSeconds ?? 0);
  }, [access.retryAfterSeconds]);

  useEffect(() => {
    if (retrySeconds <= 0) return;
    const timer = window.setTimeout(() => setRetrySeconds((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [retrySeconds]);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (access.state === "submitting" || retrySeconds > 0) return;
    const form = event.currentTarget as HTMLFormElement;
    const deviceNameInput = form.elements.namedItem("device-name") as HTMLInputElement;
    const credentialInput = form.elements.namedItem("access-token") as HTMLInputElement;

    setDeviceLoginSubmitting();
    // Start the request first, then synchronously erase the only app-owned copy
    // before yielding control back to the browser event loop.
    const login = authenticateRemoteDevice(deviceNameInput.value, credentialInput.value, access.serverUrl);
    credentialInput.value = "";
    try {
      const result = await login;
      if (result.ok) retryOfficeServer();
      else setDeviceLoginFailure(result);
    } catch {
      setDeviceLoginFailure(classifyDeviceLoginFailure(0, null));
    }
  };

  const checking = access.state === "checking";
  const submitting = access.state === "submitting";

  return (
    <main class="device-login-shell">
      <section class="device-login-card" aria-labelledby="device-login-title">
        <button
          class="device-login-language"
          type="button"
          aria-label={t("language.label")}
          onClick={() => setLocale(locale.value === "ja" ? "en" : "ja")}
        >
          {locale.value === "ja" ? "EN" : "日本語"}
        </button>
        <div class="device-login-mark" aria-hidden="true">H</div>
        <p class="eyebrow">{t("login.remote")}</p>
        <h1 id="device-login-title">{checking ? t("login.connecting") : t("login.title")}</h1>
        <p class={`device-login-message ${access.failureCode ? "is-error" : ""}`} role={access.failureCode ? "alert" : "status"}>
          {localizeRuntimeMessage(access.message)}
        </p>

        {shouldShowDeviceEnrollmentForm(access.state) && (
          <form class="device-login-form" autoComplete="off" onSubmit={submit}>
            <label>
              <span>{t("login.deviceName")}</span>
              <input name="device-name" type="text" defaultValue="My device" minLength={1} maxLength={64} autoComplete="off" required />
            </label>
            <label>
              <span>{t("login.token")} <InfoTip text={t("login.tokenNote")} align="start" /></span>
              <input name="access-token" type="password" minLength={1} maxLength={4096} autoComplete="off" autoCapitalize="none" spellcheck={false} required />
            </label>
            <button type="submit" disabled={submitting || retrySeconds > 0}>
              {submitting ? t("login.authenticating") : retrySeconds > 0 ? t("login.retryAfter", { seconds: retrySeconds }) : t("login.authenticate")}
            </button>
          </form>
        )}

        {access.state === "unavailable" && (
          <button class="device-retry-button" type="button" onClick={retryOfficeServer}>{t("login.reconnect")}</button>
        )}
      </section>
    </main>
  );
}
