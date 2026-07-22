/**
 * Hermes Studio shared visual tokens.
 *
 * Values are framework-agnostic so the Tauri shell and PWA can consume the
 * same product language. Components should prefer semantic aliases over raw
 * palette values.
 */

export const palette = {
  nightBlueprint: "#101827",
  draftingBlue: "#1B2B43",
  ledgerPaper: "#F3E8D1",
  signalCoral: "#F06A57",
  terminalAqua: "#55D6BE",
  worklightAmber: "#F2B84B",
} as const;

export const color = {
  background: palette.nightBlueprint,
  surface: palette.draftingBlue,
  surfaceSelected: palette.ledgerPaper,
  text: palette.ledgerPaper,
  textOnPaper: palette.nightBlueprint,
  focus: palette.terminalAqua,
  running: palette.terminalAqua,
  connected: palette.terminalAqua,
  waiting: palette.worklightAmber,
  inherited: palette.worklightAmber,
  blocked: palette.signalCoral,
  destructive: palette.signalCoral,
  cableQueued: palette.worklightAmber,
  cableActive: palette.terminalAqua,
  cableBlocked: palette.signalCoral,
} as const;

export const fontFamily = {
  display:
    '"Dela Gothic One", "Arial Black", "Hiragino Kaku Gothic ProN", sans-serif',
  body: '"IBM Plex Sans JP", system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  utility: '"Martian Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

export const fontSize = {
  utility: "0.6875rem",
  caption: "0.75rem",
  body: "0.875rem",
  chat: "0.9375rem",
  title: "1.5rem",
  display: "2rem",
} as const;

export const lineHeight = {
  utility: 1.35,
  body: 1.5,
  chat: 1.65,
  display: 1.05,
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  display: 400,
} as const;

export const letterSpacing = {
  utility: "0.04em",
  display: "-0.015em",
} as const;

export const space = {
  0: "0",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  5: "1.5rem",
  6: "2rem",
  7: "3rem",
  8: "4rem",
} as const;

export const radius = {
  none: "0",
  control: "2px",
  panel: "4px",
  round: "999px",
} as const;

export const borderWidth = {
  hairline: "1px",
  strong: "2px",
  focus: "2px",
} as const;

export const size = {
  pointerTargetDesktop: "40px",
  pointerTargetMobile: "44px",
  taskRailMin: "240px",
  taskRailMax: "360px",
  officeGrid: "16px",
  paneHeader: "44px",
} as const;

export const breakpoint = {
  phoneMax: "767px",
  compactMin: "768px",
  compactMax: "1279px",
  wideMin: "1280px",
} as const;

export const duration = {
  instant: "0ms",
  reducedFade: "60ms",
  pane: "160ms",
  cablePlug: "220ms",
  activityPulse: "500ms",
  characterStep: "120ms",
  characterTravelMax: "600ms",
} as const;

export const easing = {
  exit: "cubic-bezier(0.22, 1, 0.36, 1)",
  step: "steps(4, end)",
  linear: "linear",
} as const;

export const layer = {
  officeFloor: 0,
  taskCable: 10,
  character: 20,
  officeOverlay: 30,
  workbench: 40,
  drawer: 50,
  notification: 60,
  modal: 70,
} as const;

export const status = {
  running: { color: color.running, icon: "cog", label: "Running" },
  waiting: { color: color.waiting, icon: "hourglass", label: "Waiting for you" },
  blocked: { color: color.blocked, icon: "diamond", label: "Blocked" },
  idle: { color: color.text, icon: "square", label: "Idle" },
} as const;

export const inheritance = {
  global: { color: color.inherited, marker: "dash", label: "Global" },
  profile: { color: color.running, marker: "square", label: "Profile" },
  session: { color: color.text, marker: "outline", label: "Session" },
  conflict: { color: color.blocked, marker: "corner", label: "Conflict" },
} as const;

export const tokens = {
  palette,
  color,
  fontFamily,
  fontSize,
  lineHeight,
  fontWeight,
  letterSpacing,
  space,
  radius,
  borderWidth,
  size,
  breakpoint,
  duration,
  easing,
  layer,
  status,
  inheritance,
} as const;

export type PaletteToken = keyof typeof palette;
export type ColorToken = keyof typeof color;
export type StatusName = keyof typeof status;
export type InheritanceLevel = keyof typeof inheritance;
export type HermesStudioTokens = typeof tokens;

export default tokens;
