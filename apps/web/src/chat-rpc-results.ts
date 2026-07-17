import type { ChatPromptResult, ChatSteerResult } from "./chat-api";

const RPC_REJECTED = Symbol("rpc-rejected");
const RPC_COMMIT_UNCONFIRMED = Symbol("rpc-commit-unconfirmed");

type ExplicitRpcRejection = Error & { [RPC_REJECTED]: true };
type CommitUnconfirmedRpcError = Error & { [RPC_COMMIT_UNCONFIRMED]: true };

export function explicitRpcRejection(message: string): ExplicitRpcRejection {
  return Object.assign(new Error(message), { [RPC_REJECTED]: true as const });
}

export function commitUnconfirmedRpcError(message: string): CommitUnconfirmedRpcError {
  return Object.assign(new Error(message), { [RPC_COMMIT_UNCONFIRMED]: true as const });
}

export function isExplicitRpcRejection(error: unknown): error is ExplicitRpcRejection {
  return typeof error === "object" && error !== null && RPC_REJECTED in error;
}

export function isCommitUnconfirmedRpcError(error: unknown): error is CommitUnconfirmedRpcError {
  return typeof error === "object" && error !== null && RPC_COMMIT_UNCONFIRMED in error;
}

export function isCommitUnconfirmedRpcFrame(error: Record<string, unknown>): boolean {
  const data = asRecord(error.data);
  return error.code === -32008 || data?.reason === "commit_unconfirmed";
}

export function normalizePromptResult(value: unknown): ChatPromptResult | undefined {
  const result = resultRecord(value);
  return result?.status === "streaming" ? { status: "accepted" } : undefined;
}

export function interruptResultWasAccepted(value: unknown): boolean {
  return resultRecord(value)?.status === "interrupted";
}

export function normalizeSteerResult(value: unknown): ChatSteerResult {
  const result = resultRecord(value);
  if (result?.status === "queued") return { status: "queued" };
  if (result?.status === "rejected") return { status: "rejected" };
  return { status: "invalid" };
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  const outer = asRecord(value);
  return asRecord(outer?.value) ?? outer;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
