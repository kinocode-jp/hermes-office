import type { JSX } from "preact";
import { avatarForProfile, DEFAULT_CHARACTER_COUNT, defaultAvatarOrdinal, profileAvatars } from "../avatar-preferences";
import { t } from "../i18n";

const CHARACTER_SHEET_ROWS = DEFAULT_CHARACTER_COUNT;
export type CharacterSheetPosition = {
  index: number;
  column: number;
  row: number;
  backgroundPosition: string;
};

/**
 * Resolve a Hermes profile preference to the front-idle cell in the 9 × 6 atlas.
 * Profile IDs receive a deterministic default without embedding an installation inventory.
 */
export function characterSheetPosition(profileId: string): CharacterSheetPosition {
  const avatar = avatarForProfile(profileId);
  const index = avatar.kind === "creature" ? avatar.index : 0;
  const column = 0;
  const row = index;
  const x = 0;
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
  profileIndex?: number;
};

export function CharacterPortrait({
  profileId,
  profileName,
  class: className = "",
  decorative = false,
  characterIndex,
  profileIndex
}: CharacterPortraitProps) {
  const avatar = avatarForProfile(profileId);
  const savedAvatar = profileAvatars.value[profileId];
  const defaultIndex = profileIndex === undefined ? undefined : Math.max(0, profileIndex) % DEFAULT_CHARACTER_COUNT;
  const position = characterIndex !== undefined
    ? sheetPosition(characterIndex)
    : avatar.kind === "creature"
      ? sheetPosition(savedAvatar?.kind === "creature" ? avatar.index : (defaultIndex ?? avatar.index))
      : sheetPosition(0);
  const ordinal = profileIndex ?? defaultAvatarOrdinal(profileId);
  const colorCycle = Math.floor(Math.max(0, ordinal) / DEFAULT_CHARACTER_COUNT);
  const creatureStyle = {
    "--sprite-y": `${formatPercentage((position.row / (CHARACTER_SHEET_ROWS - 1)) * 100)}%`,
    "--avatar-hue": `${(colorCycle * 53) % 360}deg`
  } as JSX.CSSProperties;
  const accessibility: JSX.HTMLAttributes<HTMLSpanElement> = decorative
    ? { "aria-hidden": true }
    : { role: "img", "aria-label": t("profile.character", { name: profileName }) };

  return (
    <span
      class={`character-portrait ${className}`.trim()}
      style={avatar.kind === "custom" && characterIndex === undefined
        ? { backgroundImage: `url(${JSON.stringify(avatar.dataUrl)})`, backgroundPosition: "center", backgroundSize: "cover" }
        : creatureStyle}
      data-character-index={avatar.kind === "creature" || characterIndex !== undefined ? position.index : "custom"}
      {...accessibility}
    />
  );
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function sheetPosition(index: number): CharacterSheetPosition {
  const safeIndex = Math.max(0, Math.min(DEFAULT_CHARACTER_COUNT - 1, Math.floor(index)));
  const column = 0;
  const row = safeIndex;
  const x = 0;
  const y = (row / (CHARACTER_SHEET_ROWS - 1)) * 100;
  return { index: safeIndex, column, row, backgroundPosition: `${formatPercentage(x)}% ${formatPercentage(y)}%` };
}
