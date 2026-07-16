import type { JSX } from "preact";

const CHARACTER_SHEET_COLUMNS = 4;
const CHARACTER_SHEET_ROWS = 3;
const FALLBACK_CHARACTER_INDEX = 11;

const characterIndexByProfileId: Readonly<Record<string, number>> = {
  default: 0,
  profile-alpha: 1,
  profile-beta: 2,
  profile-gamma: 3,
  profile-delta: 4,
  profile-epsilon: 5,
  profile-zeta: 6,
  profile-eta: 7,
  "profile-kappa": 8,
  profile-theta: 9,
  profile-iota: 10
};

export type CharacterSheetPosition = {
  index: number;
  column: number;
  row: number;
  backgroundPosition: string;
};

/**
 * Resolve a Hermes profile to one square in the 4 × 3 character sheet.
 * Unknown and empty profile ids intentionally share the final fallback cell.
 */
export function characterSheetPosition(profileId: string): CharacterSheetPosition {
  const normalizedId = profileId.trim().toLocaleLowerCase("en-US");
  const index = characterIndexByProfileId[normalizedId] ?? FALLBACK_CHARACTER_INDEX;
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
};

export function CharacterPortrait({
  profileId,
  profileName,
  class: className = "",
  decorative = false
}: CharacterPortraitProps) {
  const position = characterSheetPosition(profileId);
  const accessibility: JSX.HTMLAttributes<HTMLSpanElement> = decorative
    ? { "aria-hidden": true }
    : { role: "img", "aria-label": `${profileName}のキャラクター` };

  return (
    <span
      class={`character-portrait ${className}`.trim()}
      style={{ backgroundPosition: position.backgroundPosition }}
      data-character-index={position.index}
      {...accessibility}
    />
  );
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
