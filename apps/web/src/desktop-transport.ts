const DESKTOP_PROTOCOL_PREFIX = "hermes-office.desktop.";
const OFFICE_PROTOCOL = "hermes-office.v1";

type TauriInternals = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

// The desktop shell returns a capability only when it started and owns the
// Office Server child. An existing listener with compatible response shapes is
// only an unauthenticated candidate: the shell keeps its fixed notice visible,
// and the user may open the Web UI manually after verifying the port owner. A
// fresh IPC call revalidates the owned listener before each HTTP or WebSocket
// send; the root capability is never cached in this module or an Office
// session. A null fallback is retained for non-owned browser sessions. A
// non-null invalid value is rejected rather than silently falling back, because
// that would mask owned-child security failures.

export function isTauriAssetLocation(value: Pick<Location, "protocol" | "hostname">): boolean {
  return value.protocol === "tauri:" || value.hostname === "tauri.localhost";
}

export function shouldUseDesktopCapability(
  value: Pick<Location, "protocol" | "hostname">,
  bridgeAvailable: boolean,
): boolean {
  return bridgeAvailable || isTauriAssetLocation(value);
}

export function desktopCapability(): Promise<string | undefined> {
  if (!shouldUseDesktopCapability(location, window.__TAURI_INTERNALS__ !== undefined)) return Promise.resolve(undefined);
  return loadDesktopCapability();
}

export async function desktopOwnershipIsAuthenticated(): Promise<boolean> {
  if (!shouldUseDesktopCapability(location, window.__TAURI_INTERNALS__ !== undefined)) return false;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") throw new Error("Hermes Office desktop bridge is unavailable.");
  const value = await invoke<boolean>("desktop_owned");
  if (typeof value !== "boolean") throw new Error("Hermes Office desktop ownership response is invalid.");
  if (!value) throw new Error("Hermes Office lost its authenticated desktop server.");
  return true;
}

export async function createAuthenticatedOfficeWebSocket(url: string, desktopRequired = false): Promise<WebSocket> {
  const capability = await desktopCapability();
  if (desktopRequired && capability === undefined) {
    throw new Error("Hermes Office lost its authenticated desktop server.");
  }
  return capability === undefined
    ? new WebSocket(url)
    : new WebSocket(url, [OFFICE_PROTOCOL, `${DESKTOP_PROTOCOL_PREFIX}${capability}`]);
}

export function desktopCapabilityHeader(capability: string | undefined): Record<string, string> {
  return capability === undefined ? {} : { "X-Hermes-Office-Desktop-Capability": capability };
}

async function loadDesktopCapability(): Promise<string | undefined> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") throw new Error("Hermes Office desktop bridge is unavailable.");
  const value = await invoke<string | null>("desktop_capability");
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Hermes Office desktop capability is invalid.");
  }
  return value;
}
