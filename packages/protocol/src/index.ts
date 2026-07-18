/**
 * Transport-neutral contracts shared by Hermes Office clients and server.
 *
 * This package deliberately has no runtime dependencies. Authentication and
 * authorization context are derived by the server and are never accepted from
 * a client-supplied DTO.
 */

export const PROTOCOL_VERSION = 1 as const;

/**
 * Global context crosses the settings HTTP boundary and is later embedded in
 * a `session.create` JSON-RPC frame. Keep one wire contract for every layer.
 * The context count is its UTF-8 size after JSON string escaping; the reserve
 * leaves room for the settings/RPC envelope and bounded skill selection.
 */
export const GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES = 64 * 1024;
export const GLOBAL_CONTEXT_ENVELOPE_RESERVE_UTF8_BYTES = 16 * 1024;
export const GLOBAL_CONTEXT_MAX_UTF8_BYTES =
  GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES - GLOBAL_CONTEXT_ENVELOPE_RESERVE_UTF8_BYTES;
export const GLOBAL_SETTINGS_MAX_SKILLS = 64;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** UTF-8 bytes occupied by the context inside a JSON string, excluding quotes. */
export function globalContextUtf8Bytes(value: string): number {
  const encoded = JSON.stringify(value);
  return utf8ByteLength(encoded.slice(1, -1));
}

export function isGlobalContextWithinBudget(value: string): boolean {
  return !value.includes("\0") && globalContextUtf8Bytes(value) <= GLOBAL_CONTEXT_MAX_UTF8_BYTES;
}

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type IsoDateTime = string;
/** Stable DTO sentinel used only when Hermes omits an inventory timestamp. */
export const UNKNOWN_INVENTORY_TIMESTAMP = "0001-01-01T00:00:00.000Z" as const;
export type EntityId = string;
export type ProfileId = EntityId;
export type SessionId = EntityId;
export type MessageId = EntityId;
export type BoardId = EntityId;
export type CardId = EntityId;
export type DeviceId = EntityId;
export type SkillId = EntityId;
export type EventId = EntityId;

export type RuntimeMode = "managed-sidecar" | "existing-local";
export type RuntimeState =
  | "unconfigured"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "unreachable"
  | "incompatible"
  | "error";
export type NetworkExposure = "loopback" | "tailnet" | "public";
export type AuthenticationMode =
  | "desktop-capability"
  | "local-cookie"
  | "device-cookie"
  | "tailscale-identity"
  | "oidc";

/** Increasing tiers. The server is the sole authority for the effective tier. */
export type PermissionTier = "viewer" | "operator" | "manager" | "owner";

/**
 * Mutation boundaries are independent of roles. A high tier does not make a
 * local-only operation remotely callable.
 */
export type MutationBoundary =
  | "read-only"
  | "remote-safe"
  | "step-up-required"
  | "local-only";

export type Operation =
  | "state.read"
  | "chat.session.create"
  | "chat.session.archive"
  | "chat.message.send"
  | "chat.run.cancel"
  | "chat.approval.permanent"
  | "kanban.card.create"
  | "kanban.card.update"
  | "kanban.card.comment"
  | "profile.create"
  | "profile.update"
  | "profile.delete"
  | "memory.update"
  | "skill.enable"
  | "skill.install"
  | "global-settings.update"
  | "runtime.start"
  | "runtime.stop"
  | "runtime.configure"
  | "secret.write"
  | "device.revoke"
  | "audit.read";

export interface OperationPolicy {
  operation: Operation;
  minimumTier: PermissionTier;
  boundary: MutationBoundary;
  auditable: boolean;
}

/** Canonical defaults; deployments may only make these stricter. */
export const OPERATION_POLICIES: Readonly<Record<Operation, OperationPolicy>> = {
  "state.read": policy("state.read", "viewer", "read-only", false),
  "chat.session.create": policy("chat.session.create", "operator", "remote-safe", true),
  "chat.session.archive": policy("chat.session.archive", "operator", "remote-safe", true),
  "chat.message.send": policy("chat.message.send", "operator", "remote-safe", true),
  "chat.run.cancel": policy("chat.run.cancel", "operator", "remote-safe", true),
  "chat.approval.permanent": policy("chat.approval.permanent", "owner", "local-only", true),
  "kanban.card.create": policy("kanban.card.create", "operator", "remote-safe", true),
  "kanban.card.update": policy("kanban.card.update", "operator", "remote-safe", true),
  "kanban.card.comment": policy("kanban.card.comment", "operator", "remote-safe", true),
  "profile.create": policy("profile.create", "manager", "step-up-required", true),
  "profile.update": policy("profile.update", "manager", "step-up-required", true),
  "profile.delete": policy("profile.delete", "owner", "step-up-required", true),
  "memory.update": policy("memory.update", "manager", "step-up-required", true),
  "skill.enable": policy("skill.enable", "manager", "step-up-required", true),
  "skill.install": policy("skill.install", "owner", "local-only", true),
  "global-settings.update": policy(
    "global-settings.update",
    "owner",
    "step-up-required",
    true,
  ),
  "runtime.start": policy("runtime.start", "owner", "local-only", true),
  "runtime.stop": policy("runtime.stop", "owner", "local-only", true),
  "runtime.configure": policy("runtime.configure", "owner", "local-only", true),
  "secret.write": policy("secret.write", "owner", "local-only", true),
  "device.revoke": policy("device.revoke", "owner", "step-up-required", true),
  "audit.read": policy("audit.read", "owner", "read-only", false),
} as const;

function policy(
  operation: Operation,
  minimumTier: PermissionTier,
  boundary: MutationBoundary,
  auditable: boolean,
): OperationPolicy {
  return { operation, minimumTier, boundary, auditable };
}

export interface EffectiveAccess {
  deviceId: DeviceId;
  tier: PermissionTier;
  exposure: NetworkExposure;
  authentication: AuthenticationMode;
  stepUpValidUntil?: IsoDateTime;
  allowedOperations: readonly Operation[];
}

export interface DeviceSummary {
  id: DeviceId;
  displayName: string;
  tier: PermissionTier;
  createdAt: IsoDateTime;
  lastSeenAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

/**
 * Owner-visible remote access status. Never contains secrets, digests,
 * credentials, or cookie values. Origins are returned as the canonical
 * configured HTTPS origins.
 */
export interface RemoteConfigStatus {
  enabled: boolean;
  origins: readonly string[];
  trustedProxyHops: number;
  devices: readonly DeviceSummary[];
}

export interface RuntimeStatus {
  mode: RuntimeMode;
  state: RuntimeState;
  hermesVersion?: string;
  adapterVersion: string;
  compatibilityMessage?: string;
}

export interface Capabilities {
  protocolVersion: ProtocolVersion;
  serverVersion: string;
  runtime: RuntimeStatus;
  access: EffectiveAccess;
  features: readonly (
    | "chat"
    | "profiles"
    | "skills"
    | "memory"
    | "kanban"
    | "global-inheritance"
    | "demo"
  )[];
}

export type AgentActivity =
  | "offline"
  | "idle"
  | "thinking"
  | "using-tool"
  | "waiting-for-user"
  | "blocked"
  | "error";

export interface ProfileSummary {
  id: ProfileId;
  name: string;
  avatarKey: string;
  activity: AgentActivity;
  activeSessionCount: number;
  inheritedSkillCount: number;
  ownSkillCount: number;
  revision: number;
}

export type InheritanceMode = "inherit" | "override" | "disabled";

export interface ProfileSettings {
  profileId: ProfileId;
  displayName: string;
  avatarKey: string;
  model?: string;
  systemPrompt?: string;
  memoryMode: InheritanceMode;
  skillMode: InheritanceMode;
  revision: number;
}

export interface GlobalSettings {
  defaultModel?: string;
  sharedContextEnabled: boolean;
  sharedSkillsEnabled: boolean;
  revision: number;
}

export interface OfficeSnapshot {
  generatedAt: IsoDateTime;
  sequence: number;
  capabilities: Capabilities;
  globalSettings: GlobalSettings;
  profiles: readonly ProfileSummary[];
  sessions: readonly ChatSessionSummary[];
  inventory: OfficeInventoryMetadata;
  boards: readonly KanbanBoardSummary[];
}

export type OfficeInventoryKind = "profiles" | "sessions";

export interface OfficeInventoryPagination {
  returned: number;
  available: number;
  total?: number;
  hasMore: boolean;
  truncated: boolean;
  partialFailures: number;
  nextCursor?: string;
}

export type OfficeInventoryReliability = "complete" | "partial" | "unavailable";

/**
 * Controls whether a client may treat missing inventory rows as confirmed
 * deletions. An unavailable zero-row read must retain last-known-good state;
 * a complete zero-row read is an authoritative empty inventory.
 */
export function officeInventoryReliability(
  page: Pick<OfficeInventoryPagination, "returned" | "available" | "truncated" | "partialFailures">,
): OfficeInventoryReliability {
  if (page.returned === 0 && page.available === 0 && page.partialFailures > 0) return "unavailable";
  if (page.truncated || page.partialFailures > 0) return "partial";
  return "complete";
}

export interface OfficeInventoryMetadata {
  profiles: OfficeInventoryPagination;
  sessions: OfficeInventoryPagination;
}

export interface OfficeInventoryPage {
  kind: OfficeInventoryKind;
  profiles: readonly ProfileSummary[];
  sessions: readonly ChatSessionSummary[];
  pagination: OfficeInventoryPagination;
}

export interface SkillSummary {
  id: SkillId;
  name: string;
  description?: string;
  source: "global" | "profile";
  enabled: boolean;
  requiresLocalExecution: boolean;
}

export interface MemoryDocument {
  scope: "global" | "profile";
  profileId?: ProfileId;
  content: string;
  revision: number;
  updatedAt: IsoDateTime;
}

/** Values and encrypted blobs are intentionally absent from all read models. */
export interface SecretMetadata {
  key: string;
  configured: boolean;
  updatedAt?: IsoDateTime;
}

export interface ChatSessionSummary {
  id: SessionId;
  profileId: ProfileId;
  title: string;
  activity: AgentActivity;
  /** `UNKNOWN_INVENTORY_TIMESTAMP` means the upstream field was absent. */
  createdAt: IsoDateTime;
  /** `UNKNOWN_INVENTORY_TIMESTAMP` means both update fields were absent. */
  updatedAt: IsoDateTime;
  lastMessagePreview?: string;
}

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: MessageId;
  sessionId: SessionId;
  role: ChatRole;
  content: string;
  createdAt: IsoDateTime;
  status?: "streaming" | "complete" | "failed" | "cancelled";
}

export interface SendMessageRequest {
  sessionId: SessionId;
  content: string;
  clientMessageId: string;
}

export interface CreateSessionRequest {
  profileId: ProfileId;
  title?: string;
}

export type CardStatus = "backlog" | "ready" | "in-progress" | "blocked" | "done";

export interface KanbanBoardSummary {
  id: BoardId;
  name: string;
  cardCount: number;
  revision: number;
}

export interface KanbanCard {
  id: CardId;
  boardId: BoardId;
  title: string;
  description?: string;
  status: CardStatus;
  assigneeProfileId?: ProfileId;
  revision: number;
  updatedAt: IsoDateTime;
}

export interface KanbanComment {
  id: EntityId;
  cardId: CardId;
  authorProfileId?: ProfileId;
  authorDeviceId?: DeviceId;
  content: string;
  createdAt: IsoDateTime;
}

export interface CreateCardRequest {
  boardId: BoardId;
  title: string;
  description?: string;
  assigneeProfileId?: ProfileId;
}

export interface UpdateCardRequest {
  cardId: CardId;
  title?: string;
  description?: string;
  status?: CardStatus;
  assigneeProfileId?: ProfileId | null;
}

export interface AddCardCommentRequest {
  cardId: CardId;
  content: string;
}

export interface CreateProfileRequest {
  displayName: string;
  avatarKey: string;
  model?: string;
}

export interface UpdateProfileRequest {
  profileId: ProfileId;
  displayName?: string;
  avatarKey?: string;
  model?: string | null;
  systemPrompt?: string | null;
  memoryMode?: InheritanceMode;
  skillMode?: InheritanceMode;
}

export interface UpdateMemoryRequest {
  scope: "global" | "profile";
  profileId?: ProfileId;
  content: string;
}

export interface SetSkillEnabledRequest {
  profileId?: ProfileId;
  skillId: SkillId;
  enabled: boolean;
}

export interface UpdateGlobalSettingsRequest {
  defaultModel?: string | null;
  sharedContextEnabled?: boolean;
  sharedSkillsEnabled?: boolean;
}

export interface ConfigureRuntimeRequest {
  mode: RuntimeMode;
  /** Accepted only through a verified local-native session. */
  executablePath?: string;
  endpoint?: string;
}

export interface OperationPayloadMap {
  "chat.session.create": CreateSessionRequest;
  "chat.session.archive": { sessionId: SessionId };
  "chat.message.send": SendMessageRequest;
  "chat.run.cancel": { sessionId: SessionId };
  "chat.approval.permanent": { sessionId: SessionId };
  "kanban.card.create": CreateCardRequest;
  "kanban.card.update": UpdateCardRequest;
  "kanban.card.comment": AddCardCommentRequest;
  "profile.create": CreateProfileRequest;
  "profile.update": UpdateProfileRequest;
  "profile.delete": { profileId: ProfileId };
  "memory.update": UpdateMemoryRequest;
  "skill.enable": SetSkillEnabledRequest;
  "skill.install": { source: string; expectedDigest?: string };
  "global-settings.update": UpdateGlobalSettingsRequest;
  "runtime.start": Record<string, never>;
  "runtime.stop": Record<string, never>;
  "runtime.configure": ConfigureRuntimeRequest;
  /** Secret bytes travel through a separate native one-shot channel. */
  "secret.write": { key: string; transferId: string };
  "device.revoke": { deviceId: DeviceId };
}

/** Mutation operations are exactly those with a transport payload contract. */
export type MutationOperation = keyof OperationPayloadMap;

export interface MutationRequest<TOperation extends keyof OperationPayloadMap> {
  requestId: string;
  operation: TOperation;
  payload: OperationPayloadMap[TOperation];
  idempotencyKey: string;
  expectedRevision?: number;
}

export type AnyMutationRequest = {
  [TOperation in MutationOperation]: MutationRequest<TOperation>;
}[MutationOperation];

export interface MutationAccepted<TResult> {
  requestId: string;
  acceptedAt: IsoDateTime;
  result: TResult;
}

export type EventTopic =
  | "runtime.status"
  | "profile.changed"
  | "session.changed"
  | "message.delta"
  | "message.completed"
  | "agent.activity"
  | "kanban.changed"
  | "access.changed"
  | "resync.required";

/**
 * Every stream is ordered by server sequence. Clients resume with the last
 * observed sequence and fetch a fresh snapshot after `resync.required`.
 */
export interface EventEnvelope<TPayload = unknown> {
  protocolVersion: ProtocolVersion;
  eventId: EventId;
  topic: EventTopic;
  sequence: number;
  occurredAt: IsoDateTime;
  aggregateId?: EntityId;
  aggregateRevision?: number;
  correlationId?: string;
  payload: TPayload;
}

export interface MessageDelta {
  sessionId: SessionId;
  messageId: MessageId;
  delta: string;
}

export interface AgentActivityChanged {
  profileId: ProfileId;
  sessionId?: SessionId;
  activity: AgentActivity;
  detail?: string;
}

export type ErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "step_up_required"
  | "local_only"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "runtime_unavailable"
  | "runtime_incompatible"
  | "internal_error";

export interface ProtocolError {
  code: ErrorCode;
  message: string;
  requestId?: string;
  retryable: boolean;
  retryAfterMs?: number;
  currentRevision?: number;
}

export interface AuditRecord {
  id: EntityId;
  occurredAt: IsoDateTime;
  operation: Operation;
  outcome: "allowed" | "denied" | "failed";
  deviceId: DeviceId;
  actorSubject: string;
  targetId?: EntityId;
  requestId?: string;
  detail?: string;
}
