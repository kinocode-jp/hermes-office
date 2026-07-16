import type { ApprovalChoice } from "./domain";

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function approvalChoices(value: unknown, allowPermanent: boolean): ApprovalChoice[] {
  const allowed = new Set<ApprovalChoice>(["once", "session", "deny", ...(allowPermanent ? ["always" as const] : [])]);
  return stringArray(value).filter((choice): choice is ApprovalChoice => allowed.has(choice as ApprovalChoice));
}

export function gatewayMessageId(payload: Record<string, unknown>): string | undefined {
  return stringValue(payload.messageId) ?? stringValue(payload.message_id);
}

export function nowTime(): string {
  return new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}
