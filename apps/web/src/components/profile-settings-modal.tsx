import { useEffect, useState } from "preact/hooks";
import type { SettingsTab } from "../domain";
import { profileDisplayName } from "../profile-names";
import { closeProfileSettingsModal, profileList, profileSettingsModalId } from "../store";
import { t } from "../i18n";
import { CharacterPortrait } from "./character-portrait";
import { LiveSettings } from "./live-settings";
import { useMobileOverlay } from "./use-mobile-overlay";

export function ProfileSettingsModal() {
  const profile = profileList.value.find((item) => item.id === profileSettingsModalId.value);
  const open = profileSettingsModalId.value !== null && profile !== undefined;
  const [tab, setTab] = useState<SettingsTab>("soul");
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open,
    onClose: closeProfileSettingsModal,
    viewport: "(min-width: 0px)",
  });

  useEffect(() => { setTab("soul"); }, [profile?.id]);

  if (!open || !profile) return null;
  const name = profileDisplayName(profile);
  return (
    <div class="profile-settings-modal-layer" data-modal-affordance="true">
      <button class="profile-settings-modal-scrim" type="button" aria-label={t("common.close")} onClick={closeProfileSettingsModal} />
      <section
        ref={overlay.ref}
        class="profile-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-settings-modal-title"
        tabIndex={-1}
      >
        <header class="profile-settings-modal-head">
          <div class="profile-settings-modal-identity">
            <CharacterPortrait profileId={profile.id} profileName={name} class="character-portrait--modal" decorative />
            <div>
              <span>{t("profile.settings")}</span>
              <h2 id="profile-settings-modal-title">{name}</h2>
              <small>{profile.id}</small>
            </div>
          </div>
          <button type="button" class="profile-settings-modal-close" onClick={closeProfileSettingsModal} aria-label={t("common.close")}>×</button>
        </header>
        <div class="profile-settings-modal-body">
          <LiveSettings
            profileId={profile.id}
            profileLabel={name}
            initialTab="soul"
            activeTab={tab}
            onTabChange={setTab}
          />
        </div>
      </section>
    </div>
  );
}
