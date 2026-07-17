import { useEffect, useRef, useState } from "preact/hooks";
import { avatarForProfile, beginCustomAvatarChange, DEFAULT_CHARACTER_COUNT, isAvatarChangeCurrent, resetProfileAvatar, setCreatureAvatar, setCustomAvatar } from "../avatar-preferences";
import { CharacterPortrait } from "./character-portrait";
import { InfoTip } from "./info-tip";
import { t } from "../i18n";
import { canRestoreModalFocus, isTopmostModal, registerModal } from "../modal-layer";

type AvatarPickerProps = {
  profileId: string;
  profileName: string;
  onClose: () => void;
};

const MAX_FILE_BYTES = 1_000_000;

export function canDismissAvatarPicker(uploading: boolean, resetting: boolean): boolean {
  return !uploading && !resetting;
}

export function AvatarPicker({ profileId, profileName, onClose }: AvatarPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const selected = avatarForProfile(profileId);
  const busy = !canDismissAvatarPicker(uploading, resetting);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const unregister = dialog ? registerModal(dialog) : undefined;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button, input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])') ?? [])];
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal(dialogRef.current)) return;
      if (event.key === "Escape") { event.preventDefault(); if (!busyRef.current) onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { unregister?.(); document.removeEventListener("keydown", handleKeyDown); if (canRestoreModalFocus(previousFocus)) previousFocus?.focus(); };
  }, [onClose]);

  async function loadCustomImage(file?: File): Promise<void> {
    setError(null);
    if (!file || file.size > MAX_FILE_BYTES || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      setError(t("avatar.invalid"));
      return;
    }
    const generation = beginCustomAvatarChange(profileId);
    setUploading(true);
    try {
      const dataUrl = await readFile(file);
      if (await setCustomAvatar(profileId, dataUrl, generation)) onClose();
      else if (isAvatarChangeCurrent(profileId, generation)) setError(t("avatar.saveFailed"));
    } catch {
      setError(t("avatar.invalid"));
    } finally {
      setUploading(false);
    }
  }

  async function resetAvatar(): Promise<void> {
    setError(null);
    setResetting(true);
    try {
      if (await resetProfileAvatar(profileId)) onClose();
      else setError(t("avatar.resetFailed"));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div class="avatar-picker-backdrop" role="presentation" onClick={(event) => { if (!busy && event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} class="avatar-picker" role="dialog" aria-modal="true" aria-labelledby="avatar-picker-title" aria-describedby="avatar-picker-description">
        <header>
          <div>
            <small>{t("avatar.kicker")}</small>
            <h3 id="avatar-picker-title">{t("avatar.title", { name: profileName })} <InfoTip text={`${t("avatar.description")} ${t("avatar.note")}`} align="end" /></h3>
          </div>
          <button type="button" disabled={busy} onClick={onClose} aria-label={t("common.close")}>×</button>
        </header>
        <p id="avatar-picker-description" class="visually-hidden">{t("avatar.description")}</p>
        <div class="avatar-choice-grid">
          {Array.from({ length: DEFAULT_CHARACTER_COUNT }, (_, index) => (
            <button
              key={index}
              type="button"
              class={selected.kind === "creature" && selected.index === index ? "is-selected" : ""}
              disabled={uploading || resetting}
              aria-label={t("avatar.creature", { number: index + 1 })}
              aria-pressed={selected.kind === "creature" && selected.index === index}
              onClick={() => { setCreatureAvatar(profileId, index); onClose(); }}
            >
              <CharacterPortrait
                profileId={profileId}
                profileName={t("avatar.creature", { number: index + 1 })}
                characterIndex={index}
                decorative
              />
            </button>
          ))}
        </div>
        <div class="avatar-picker-actions">
          <input ref={inputRef} type="file" hidden aria-hidden="true" tabIndex={-1} disabled={uploading || resetting} accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void loadCustomImage(file); }} />
          <button type="button" class="avatar-upload-button" disabled={uploading || resetting} onClick={() => inputRef.current?.click()}>{t("avatar.upload")}</button>
          <button type="button" class="avatar-reset-button" aria-busy={resetting} disabled={uploading || resetting} onClick={() => void resetAvatar()}>{resetting ? t("avatar.resetting") : t("avatar.reset")}</button>
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
