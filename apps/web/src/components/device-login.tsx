import { useEffect, useState } from "preact/hooks";
import { authenticateRemoteDevice } from "../office-api";
import {
  officeAccess,
  retryOfficeServer,
  setDeviceLoginFailure,
  setDeviceLoginSubmitting
} from "../store";

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
    const result = await login;
    if (result.ok) retryOfficeServer();
    else setDeviceLoginFailure(result);
  };

  const checking = access.state === "checking";
  const submitting = access.state === "submitting";

  return (
    <main class="device-login-shell">
      <section class="device-login-card" aria-labelledby="device-login-title">
        <div class="device-login-mark" aria-hidden="true">H</div>
        <p class="eyebrow">Hermes Office · Remote device</p>
        <h1 id="device-login-title">{checking ? "Officeへ接続中" : "この端末でログイン"}</h1>
        <p class={`device-login-message ${access.failureCode ? "is-error" : ""}`} role={access.failureCode ? "alert" : "status"}>
          {access.message}
        </p>

        {!checking && (
          <form class="device-login-form" autoComplete="off" onSubmit={submit}>
            <label>
              <span>端末名</span>
              <input name="device-name" type="text" defaultValue="My device" minLength={1} maxLength={64} autoComplete="off" required />
            </label>
            <label>
              <span>アクセストークン</span>
              <input name="access-token" type="password" minLength={1} maxLength={4096} autoComplete="off" autoCapitalize="none" spellcheck={false} required />
            </label>
            <button type="submit" disabled={submitting || retrySeconds > 0}>
              {submitting ? "認証中…" : retrySeconds > 0 ? `${retrySeconds}秒後に再試行` : "端末を認証"}
            </button>
          </form>
        )}

        {access.state === "unavailable" && (
          <button class="device-retry-button" type="button" onClick={retryOfficeServer}>Office Serverへ再接続</button>
        )}
        <p class="device-login-note">Tokenは保存されず、この認証リクエストにだけ使用されます。</p>
      </section>
    </main>
  );
}
