import { useEffect, useId, useRef, useState } from "preact/hooks";
import { t } from "../i18n";

type InfoTipProps = {
  text: string;
  /** Horizontal anchor of the bubble relative to the trigger. */
  align?: "start" | "center" | "end";
  /** Vertical side the bubble opens toward; use "bottom" near the top edge. */
  side?: "top" | "bottom";
};

/** Small info trigger that reveals its explanation on hover, focus, or tap. */
export function InfoTip({ text, align = "center", side = "top" }: InfoTipProps) {
  const bubbleId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
        rootRef.current?.querySelector("button")?.blur();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  return (
    <span ref={rootRef} class={`info-tip info-tip--${align} info-tip--${side} ${open ? "is-open" : ""}`}>
      <button
        type="button"
        class="info-tip__trigger"
        aria-label={t("common.info")}
        aria-describedby={bubbleId}
        aria-expanded={open}
        onClick={(event) => setOpen((value) => {
          if (value) event.currentTarget.blur();
          return !value;
        })}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.currentTarget.blur();
          }
        }}
      >i</button>
      {/* On phones the fixed banner can cover its own trigger; tapping the bubble also closes it. */}
      <span role="tooltip" id={bubbleId} class="info-tip__bubble" onClick={() => setOpen(false)}>{text}</span>
    </span>
  );
}
