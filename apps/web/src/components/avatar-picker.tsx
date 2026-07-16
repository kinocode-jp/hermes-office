import { useEffect, useRef, useState } from "preact/hooks";
import { avatarForProfile, resetProfileAvatar, setCreatureAvatar, setCustomAvatar } from "../avatar-preferences";
import { CharacterPortrait } from "./character-portrait";
import { InfoTip } from "./info-tip";
import { t } from "../i18n";

type AvatarPickerProps = {
  profileId: string;
  profileName: string;
  onClose: () => void;
};

const MAX_FILE_BYTES = 1_000_000;

export function AvatarPicker({ profileId, profileName, onClose }: AvatarPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = avatarForProfile(profileId);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button, input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); previousFocus?.focus(); };
  }, [onClose]);

  async function loadCustomImage(file?: File): Promise<void> {
    setError(null);
    if (!file || file.size > MAX_FILE_BYTES || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      setError(t("avatar.invalid"));
      return;
    }
    const dataUrl = await readFile(file);
    if (await setCustomAvatar(profileId, dataUrl)) onClose();
    else setError(t("avatar.saveFailed"));
  }

  return (
    <div class="avatar-picker-backdrop" role="presentation" onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} class="avatar-picker" role="dialog" aria-modal="true" aria-labelledby="avatar-picker-title" aria-describedby="avatar-picker-description">
        <header>
          <div>
            <small>{t("avatar.kicker")}</small>
            <h3 id="avatar-picker-title">{t("avatar.title", { name: profileName })} <InfoTip text={`${t("avatar.description")} ${t("avatar.note")}`} align="end" /></h3>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")}>×</button>
        </header>
        <p id="avatar-picker-description" class="visually-hidden">{t("avatar.description")}</p>
        <div class="avatar-choice-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <button
              key={index}
              type="button"
              class={selected.kind === "creature" && selected.index === index ? "is-selected" : ""}
              aria-label={t("avatar.creature", { number: index + 1 })}
              aria-pressed={selected.kind === "creature" && selected.index === index}
              onClick={() => { setCreatureAvatar(profileId, index); onClose(); }}
            >
              <CharacterPortrait profileId={profileId} profileName={t("avatar.creature", { number: index + 1 })} characterIndex={index} decorative />
            </button>
          ))}
        </div>
        <div class="avatar-picker-actions">
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void loadCustomImage(file); }} />
          <button type="button" class="avatar-upload-button" onClick={() => inputRef.current?.click()}>{t("avatar.upload")}</button>
          <button type="button" class="avatar-reset-button" onClick={() => { resetProfileAvatar(profileId); onClose(); }}>{t("avatar.reset")}</button>
        </div>
        {error && <p class="avatar-picker-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("invalid image"));
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(file);
  });
}
