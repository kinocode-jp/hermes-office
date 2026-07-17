import { useEffect, useRef, useState } from "preact/hooks";
import {
  activeFontScale,
  activeTheme,
  fontScales,
  setFontScale,
  setTheme,
  themes,
  type Theme,
} from "../appearance";
import { locale } from "../i18n";
import { InfoTip } from "./info-tip";
import { canRestoreModalFocus, hasOpenModal, isTopmostModal, registerModal } from "../modal-layer";

const themeDetails: Record<Theme, { name: string; ja: string; en: string }> = {
  paper: { name: "Paper", ja: "白", en: "Pure white" },
  mint: { name: "Mint", ja: "やさしい緑", en: "Soft green" },
  midnight: { name: "Midnight", ja: "ダーク", en: "Dark" },
};

export function AppearanceSettings() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const restoreFocusTimer = useRef<number | undefined>(undefined);
  const isJapanese = locale.value === "ja";
  const copy = isJapanese ? {
    trigger: "表示設定",
    close: "閉じる",
    title: "表示",
    theme: "テーマ",
    textSize: "文字サイズ",
    hint: "文字の大きさをこの端末向けに保存します。オフィスの配置は変わりません。",
  } : {
    trigger: "Appearance settings",
    close: "Close",
    title: "Appearance",
    theme: "Theme",
    textSize: "Text size",
    hint: "Text size is saved on this device without changing the office layout.",
  };

  useEffect(() => {
    window.clearTimeout(restoreFocusTimer.current);
    restoreFocusTimer.current = undefined;
    if (!open) return;
    const unregister = panel.current ? registerModal(panel.current) : undefined;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal(panel.current)) return;
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
      if (event.key !== "Tab") return;
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])') ?? [])];
      if (controls.length === 0) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      unregister?.();
      window.removeEventListener("keydown", onKeyDown);
      const restoreFocus = previousFocus.current;
      restoreFocusTimer.current = window.setTimeout(() => {
        restoreFocusTimer.current = undefined;
        if (canRestoreModalFocus(restoreFocus)) restoreFocus?.focus();
      }, 0);
    };
  }, [open]);

  return (
    <div class="appearance-control">
      <button
        class={`appearance-trigger ${open ? "is-open" : ""}`}
        type="button"
        aria-label={copy.trigger}
        aria-expanded={open}
        aria-controls="appearance-panel"
        onClick={() => setOpen((current) => current ? false : hasOpenModal() ? false : true)}
      >
        <span aria-hidden="true">Aa</span>
      </button>

      {open && (
        <>
          <button class="appearance-scrim" data-modal-affordance="true" type="button" aria-label={copy.close} onPointerDown={() => setOpen(false)} onClick={() => setOpen(false)} />
          <aside ref={panel} id="appearance-panel" class="appearance-panel" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
            <header>
              <div>
                <p>DISPLAY CONSOLE</p>
                <h2 id="appearance-title">{copy.title} <span>{isJapanese ? "/ Appearance" : "/ 表示"}</span></h2>
              </div>
              <button type="button" aria-label={copy.close} onPointerDown={() => setOpen(false)} onClick={() => setOpen(false)}>×</button>
            </header>

            <section aria-labelledby="theme-heading">
              <div class="appearance-section-title">
                <h3 id="theme-heading">{copy.theme}</h3>
                <small>{activeTheme.value}</small>
              </div>
              <div class="theme-choices">
                {themes.map((theme) => (
                  <button
                    key={theme}
                    class={`theme-choice theme-choice--${theme} ${activeTheme.value === theme ? "is-active" : ""}`}
                    type="button"
                    aria-pressed={activeTheme.value === theme}
                    onClick={() => setTheme(theme)}
                  >
                    <i aria-hidden="true"><span /><span /><span /></i>
                    <b>{themeDetails[theme].name}</b>
                    <small>{isJapanese ? themeDetails[theme].ja : themeDetails[theme].en}</small>
                  </button>
                ))}
              </div>
            </section>

            <section aria-labelledby="font-heading">
              <div class="appearance-section-title">
                <h3 id="font-heading">{copy.textSize} <InfoTip text={copy.hint} align="start" /></h3>
                <output>{Math.round(activeFontScale.value * 100)}%</output>
              </div>
              <div class="font-size-choices" role="group" aria-label={copy.textSize}>
                {fontScales.map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    class={activeFontScale.value === scale ? "is-active" : ""}
                    aria-pressed={activeFontScale.value === scale}
                    onClick={() => setFontScale(scale)}
                  >
                    <span style={{ fontSize: `${scale}em` }}>A</span>
                    <small>{Math.round(scale * 100)}%</small>
                  </button>
                ))}
              </div>
            </section>
          </aside>
        </>
      )}
    </div>
  );
}
