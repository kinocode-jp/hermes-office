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

let capabilityCache: { bridge: TauriInternals | undefined; request: Promise<string | undefined> } | undefined;

// The desktop shell returns a capability only when it started and owns the
// Office Server child. When it attaches to an existing compatible server, the
// shell normally navigates the WebView to the server origin, so the page has no
// Tauri bridge and uses ordinary browser cookie auth. The null fallback here is
// a defense-in-depth case: if the bridge is still invoked on an attached remote
// page, null means no capability. A non-null invalid value is rejected rather
// than silently falling back, because that would mask owned-child security
// failures.

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
  const currentBridge = window.__TAURI_INTERNALS__;
  if (capabilityCache === undefined || capabilityCache.bridge !== currentBridge) {
    capabilityCache = { bridge: currentBridge, request: loadDesktopCapability() };
  }
  return capabilityCache.request;
}

export async function createAuthenticatedOfficeWebSocket(url: string): Promise<WebSocket> {
  const capability = await desktopCapability();
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
