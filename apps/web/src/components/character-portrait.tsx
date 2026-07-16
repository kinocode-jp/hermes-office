import type { JSX } from "preact";
import { avatarForProfile } from "../avatar-preferences";
import { t } from "../i18n";

const CHARACTER_SHEET_COLUMNS = 4;
const CHARACTER_SHEET_ROWS = 3;
export type CharacterSheetPosition = {
  index: number;
  column: number;
  row: number;
  backgroundPosition: string;
};

/**
 * Resolve a Hermes profile preference to one square in the 4 × 3 creature sheet.
 * Known profiles keep stable cells; new profiles receive a deterministic default.
 */
export function characterSheetPosition(profileId: string): CharacterSheetPosition {
  const avatar = avatarForProfile(profileId);
  const index = avatar.kind === "creature" ? avatar.index : 0;
  const column = index % CHARACTER_SHEET_COLUMNS;
  const row = Math.floor(index / CHARACTER_SHEET_COLUMNS);
  const x = (column / (CHARACTER_SHEET_COLUMNS - 1)) * 100;
  const y = (row / (CHARACTER_SHEET_ROWS - 1)) * 100;

  return {
    index,
    column,
    row,
    backgroundPosition: `${formatPercentage(x)}% ${formatPercentage(y)}%`
  };
}

type CharacterPortraitProps = {
  profileId: string;
  profileName: string;
  class?: string;
  decorative?: boolean;
  characterIndex?: number;
};

export function CharacterPortrait({
  profileId,
  profileName,
  class: className = "",
  decorative = false,
  characterIndex
}: CharacterPortraitProps) {
  const avatar = avatarForProfile(profileId);
  const position = characterIndex === undefined ? characterSheetPosition(profileId) : sheetPosition(characterIndex);
  const accessibility: JSX.HTMLAttributes<HTMLSpanElement> = decorative
    ? { "aria-hidden": true }
    : { role: "img", "aria-label": t("profile.character", { name: profileName }) };

  return (
    <span
      class={`character-portrait ${className}`.trim()}
      style={avatar.kind === "custom" && characterIndex === undefined
        ? { backgroundImage: `url(${JSON.stringify(avatar.dataUrl)})`, backgroundPosition: "center", backgroundSize: "cover" }
        : { backgroundPosition: position.backgroundPosition }}
      data-character-index={avatar.kind === "creature" || characterIndex !== undefined ? position.index : "custom"}
      {...accessibility}
    />
  );
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function sheetPosition(index: number): CharacterSheetPosition {
  const safeIndex = Math.max(0, Math.min(11, Math.floor(index)));
  const column = safeIndex % CHARACTER_SHEET_COLUMNS;
  const row = Math.floor(safeIndex / CHARACTER_SHEET_COLUMNS);
  const x = (column / (CHARACTER_SHEET_COLUMNS - 1)) * 100;
  const y = (row / (CHARACTER_SHEET_ROWS - 1)) * 100;
  return { index: safeIndex, column, row, backgroundPosition: `${formatPercentage(x)}% ${formatPercentage(y)}%` };
}
