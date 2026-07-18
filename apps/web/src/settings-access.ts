import type { Operation } from "@hermes-office/protocol";
import type { OfficeSnapshot, SettingsTab } from "./domain";

export type SettingsMutationAccess = {
  global: boolean;
  skill: boolean;
  soul: boolean;
  memory: boolean;
  localOwner: boolean;
  hostAdmin: boolean;
};

export function settingsMutationAccess(snapshot: OfficeSnapshot | undefined): SettingsMutationAccess {
  const allowed = new Set<Operation>(snapshot?.capabilities.access.allowedOperations ?? []);
  const access = snapshot?.capabilities.access;
  return {
    global: allowed.has("global-settings.update"),
    skill: allowed.has("skill.enable"),
    soul: allowed.has("profile.update"),
    memory: allowed.has("memory.update"),
    localOwner: access?.tier === "owner" && access.exposure === "loopback",
    hostAdmin: access?.authentication === "desktop-capability" && access?.tier === "owner",
  };
}

export function canMutateSettingsTab(access: SettingsMutationAccess, tab: SettingsTab): boolean {
  if (tab === "host") return access.hostAdmin;
  if (tab === "global") return access.global;
  if (tab === "skills") return access.skill;
  if (tab === "soul") return access.soul;
  return access.memory;
}
