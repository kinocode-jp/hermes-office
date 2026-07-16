import { useId } from "preact/hooks";
import { t } from "../i18n";

type InfoTipProps = {
  text: string;
  /** Horizontal anchor of the bubble relative to the trigger. */
  align?: "start" | "center" | "end";
  /** Vertical side the bubble opens toward; use "bottom" near the top edge. */
  side?: "top" | "bottom";
};

/** Small ⓘ trigger that reveals its explanation on hover or keyboard focus. */
export function InfoTip({ text, align = "center", side = "top" }: InfoTipProps) {
  const bubbleId = useId();
  return (
    <span class={`info-tip info-tip--${align} info-tip--${side}`}>
      {/* Explicit focus keeps :focus-within tooltips working on tap in iOS Safari. */}
      <button type="button" class="info-tip__trigger" aria-label={t("common.info")} aria-describedby={bubbleId} onClick={(event) => event.currentTarget.focus()}>i</button>
      <span role="tooltip" id={bubbleId} class="info-tip__bubble">{text}</span>
    </span>
  );
}
