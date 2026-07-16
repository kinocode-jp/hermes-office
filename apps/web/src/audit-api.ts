import { officeFetchJson } from "./office-api";

export type AccessAuditOperation = "auth.local" | "auth.device" | "auth.logout" | "audit.read";
export type AccessAuditOutcome = "allowed" | "denied" | "rate_limited";

export type AccessAuditEntry = {
  occurredAt: string;
  operation: AccessAuditOperation;
  outcome: AccessAuditOutcome;
  deviceName: string | null;
  local: boolean;
};

export type AccessAuditSnapshot = {
  records: AccessAuditEntry[];
  currentAccess: { deviceName: string; local: boolean } | null;
};

const MAX_AUDIT_RECORDS = 256;
const auditListeners = new Set<() => void>();

export async function fetchAccessAudit(): Promise<AccessAuditSnapshot> {
  const response = await officeFetchJson<unknown>("/api/v1/audit");
  return parseAccessAuditResponse(response);
}

export function subscribeAccessAudit(listener: () => void): () => void {
  auditListeners.add(listener);
  return () => auditListeners.delete(listener);
}

export function notifyAccessAuditChanged(): void {
  for (const listener of auditListeners) {
    try {
      listener();
    } catch {
      // One settings surface must not prevent the others from refreshing.
    }
  }
}

export function shouldRefreshAccessAudit(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.audit)) return true;
  return payload.audit.operation !== "audit.read";
}

export function parseAccessAuditResponse(value: unknown): AccessAuditSnapshot {
  if (!isRecord(value) || !Array.isArray(value.records) || value.records.length > MAX_AUDIT_RECORDS) {
    throw new Error("監査ログの応答形式が正しくありません。");
  }

  const chronological = value.records.flatMap((candidate): AccessAuditEntry[] => {
    if (!isRecord(candidate)) return [];
    const operation = safeOperation(candidate.operation);
    const outcome = safeOutcome(candidate.outcome);
    const occurredAt = safeTimestamp(candidate.occurredAt);
    const deviceName = safeDeviceName(candidate.deviceName);
    if (operation === undefined || outcome === undefined || occurredAt === undefined || deviceName === undefined || typeof candidate.local !== "boolean") {
      return [];
    }
    return [{ occurredAt, operation, outcome, deviceName, local: candidate.local }];
  });

  const currentRecord = [...chronological].reverse().find((record) => record.operation === "audit.read" && record.outcome === "allowed");
  return {
    records: chronological.reverse(),
    currentAccess: currentRecord === undefined
      ? null
      : {
          deviceName: currentRecord.deviceName ?? (currentRecord.local ? "このMac" : "Remote device"),
          local: currentRecord.local,
        },
  };
}

function safeOperation(value: unknown): AccessAuditOperation | undefined {
  return value === "auth.local" || value === "auth.device" || value === "auth.logout" || value === "audit.read" ? value : undefined;
}

function safeOutcome(value: unknown): AccessAuditOutcome | undefined {
  return value === "allowed" || value === "denied" || value === "rate_limited" ? value : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function safeDeviceName(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
