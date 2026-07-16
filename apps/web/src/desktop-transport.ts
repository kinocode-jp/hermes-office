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

let capabilityRequest: Promise<string | undefined> | undefined;

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
  capabilityRequest ??= loadDesktopCapability();
  return capabilityRequest;
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

async function loadDesktopCapability(): Promise<string> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") throw new Error("Hermes Office desktop bridge is unavailable.");
  const value = await invoke<string>("desktop_capability");
  if (typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Hermes Office desktop capability is invalid.");
  }
  return value;
}
