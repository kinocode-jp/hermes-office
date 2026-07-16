import { signal } from "@preact/signals";

export const APPEARANCE_STORAGE_KEY = "hermes-office:appearance:v1";

export const themes = ["paper", "mint", "midnight"] as const;
export const fontScales = [0.9, 1, 1.1, 1.2] as const;

export type Theme = (typeof themes)[number];
export type FontScale = (typeof fontScales)[number];

type AppearancePreferences = {
  theme: Theme;
  fontScale: FontScale;
};

const defaults: AppearancePreferences = { theme: "paper", fontScale: 1 };
const initial = readPreferences();

export const activeTheme = signal<Theme>(initial.theme);
export const activeFontScale = signal<FontScale>(initial.fontScale);

export function initializeAppearance(): void {
  applyAppearance(activeTheme.value, activeFontScale.value);
}

export function setTheme(theme: Theme): void {
  activeTheme.value = theme;
  applyAppearance(theme, activeFontScale.value);
  persistPreferences();
}

export function setFontScale(fontScale: FontScale): void {
  activeFontScale.value = fontScale;
  applyAppearance(activeTheme.value, fontScale);
  persistPreferences();
}

function readPreferences(): AppearancePreferences {
  if (typeof localStorage === "undefined") return defaults;
  try {
    const candidate = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "null") as Partial<AppearancePreferences> | null;
    return {
      theme: isTheme(candidate?.theme) ? candidate.theme : defaults.theme,
      fontScale: isFontScale(candidate?.fontScale) ? candidate.fontScale : defaults.fontScale,
    };
  } catch {
    return defaults;
  }
}

function persistPreferences(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({
      theme: activeTheme.value,
      fontScale: activeFontScale.value,
    } satisfies AppearancePreferences));
  } catch {
    // Appearance is non-critical; keep the active session usable when storage is unavailable.
  }
}

function applyAppearance(theme: Theme, fontScale: FontScale): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.fontScale = String(fontScale).replace(".", "-");
  root.style.setProperty("--font-scale", String(fontScale));
  root.style.colorScheme = theme === "midnight" ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor(theme));
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (themes as readonly string[]).includes(value);
}

function isFontScale(value: unknown): value is FontScale {
  return typeof value === "number" && (fontScales as readonly number[]).includes(value);
}

function themeColor(theme: Theme): string {
  if (theme === "midnight") return "#101827";
  if (theme === "mint") return "#effaf6";
  return "#ffffff";
}
