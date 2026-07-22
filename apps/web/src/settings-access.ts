import type { Operation } from "@hermes-studio/protocol";
import type { OfficeSnapshot, SettingsTab } from "./domain";

export type SettingsMutationAccess = {
  global: boolean;
  skill: boolean;
  soul: boolean;
  memory: boolean;
  config: boolean;
  /**
   * Privileged config + secrets: server advertises ops only for local owners
   * or Tailscale remote owners when HERMES_STUDIO_REMOTE_PRIVILEGED is on.
   */
  privileged: boolean;
  /** Fixed allowlisted host app installation (local or privileged Tailnet owner). */
  hostApps: boolean;
  localOwner: boolean;
  hostAdmin: boolean;
};

export function settingsMutationAccess(snapshot: OfficeSnapshot | undefined): SettingsMutationAccess {
  const allowed = new Set<Operation>(snapshot?.capabilities.access.allowedOperations ?? []);
  const access = snapshot?.capabilities.access;
  const hostAdmin = access?.authentication === "desktop-capability" && access?.tier === "owner";
  return {
    global: allowed.has("global-settings.update"),
    skill: allowed.has("skill.enable"),
    soul: allowed.has("profile.update"),
    memory: allowed.has("memory.update"),
    config: allowed.has("profile-config.update"),
    // Trust server allowedOperations (includes remote-privileged filter).
    privileged: allowed.has("privileged-config.read")
      && allowed.has("privileged-config.update")
      && allowed.has("secret.write"),
    hostApps: allowed.has("host-app.install"),
    localOwner: access?.tier === "owner" && access.exposure === "loopback",
    hostAdmin,
  };
}

export function canMutateSettingsTab(access: SettingsMutationAccess, tab: SettingsTab): boolean {
  if (tab === "host") return access.hostAdmin;
  if (tab === "global") return access.global;
  if (tab === "skills") return access.skill;
  if (tab === "soul") return access.soul;
  if (tab === "config") return access.config;
  if (tab === "privileged") return access.privileged;
  return access.memory;
}
