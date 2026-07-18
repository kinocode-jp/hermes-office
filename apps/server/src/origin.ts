export function normalizeOrigin(origin: string): string {
  const value = origin.trim();
  if (value === "" || value === "*" || value === "null") return value;
  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return "";
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (parsed.pathname !== "/") return "";
      return parsed.origin;
    }
    // Non-http(s) schemes: require a non-empty host and no path/query/fragment.
    if (parsed.hostname === "") return "";
    if (parsed.pathname !== "" && parsed.pathname !== "/") return "";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
  } catch {
    return "";
  }
}

const SPECIAL_TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

function isSpecialTauriOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false;
  return SPECIAL_TAURI_ORIGINS.has(normalizeOrigin(origin));
}

export function isTrustedLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false;
  if (isSpecialTauriOrigin(origin)) return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  if (isSpecialTauriOrigin(origin)) return true;
  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}
