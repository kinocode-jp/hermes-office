import type { AccessAuditSnapshot } from "./audit-api";
import { t } from "./i18n";

export function accessDeviceName(current: AccessAuditSnapshot["currentAccess"] | undefined): string {
  if (current === null || current === undefined) return t("audit.checking");
  return current.deviceName ?? t(current.local ? "audit.thisMac" : "audit.remoteDevice");
}
