/** JSON-compatible values used by the Hermes REST and JSON-RPC surfaces. */
export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
/** `undefined` is accepted while constructing params and omitted by the wire encoder. */
export type JsonObject = { [key: string]: JsonValue | undefined }

/** A live gateway id is process-local. A stored id survives reconnects. */
export type LiveSessionId = string
export type StoredSessionId = string
export type ProfileName = string

export type HermesConnectionState = 'closed' | 'connecting' | 'error' | 'idle' | 'open'
export type HermesAuthMode = 'basic' | 'loopback' | 'oauth' | 'session' | (string & {})

export interface HermesStatus {
  active_sessions: number
  auth_providers?: string[]
  auth_required?: boolean
  config_version: number
  gateway_mode?: 'multiple' | 'multiplex' | 'none' | 'single' | (string & {})
  gateway_running: boolean
  gateway_state: null | string
  latest_config_version: number
  profiles?: ProfileName[]
  release_date: string
  version: string
  [key: string]: unknown
}

export interface HermesProfile {
  description: string
  description_auto: boolean
  distribution_name?: null | string
  distribution_source?: null | string
  distribution_version?: null | string
  gateway_running: boolean
  has_alias: boolean
  has_env: boolean
  is_default: boolean
  model: null | string
  name: ProfileName
  path: string
  provider: null | string
  skill_count: number
}

export interface HermesProfileCreate {
  clone_all?: boolean
  clone_from?: ProfileName
  description?: string
  hub_skills?: string[]
  keep_skills?: string[]
  model?: string
  name: ProfileName
  no_skills?: boolean
  provider?: string
}

export type HermesMessageRole = 'assistant' | 'system' | 'tool' | 'user'

export interface HermesMessage {
  content: unknown
  name?: string
  reasoning?: null | string
  role: HermesMessageRole
  text?: unknown
  timestamp?: number
  tool_call_id?: null | string
  tool_calls?: unknown
  tool_name?: string
  [key: string]: unknown
}

export interface HermesSession {
  archived?: boolean
  cwd?: null | string
  ended_at: null | number
  id: StoredSessionId
  input_tokens: number
  is_active: boolean
  last_active: number
  message_count: number
  model: null | string
  output_tokens: number
  parent_session_id?: null | StoredSessionId
  preview: null | string
  profile?: ProfileName
  source: null | string
  started_at: number
  title: null | string
  tool_call_count: number
  [key: string]: unknown
}

export interface HermesSessionPage {
  errors?: Array<{ error: string; profile: ProfileName }>
  limit: number
  offset: number
  profile_totals?: Record<ProfileName, number>
  sessions: HermesSession[]
  total: number
}

export interface HermesSessionRuntimeInfo {
  approval_mode?: 'manual' | 'off' | 'smart'
  branch?: string
  cwd?: string
  desktop_contract?: number
  fast?: boolean
  model?: string
  personality?: string
  profile_name?: ProfileName
  provider?: string
  reasoning_effort?: string
  running?: boolean
  service_tier?: string
  skills?: Record<string, string[]> | string[]
  tools?: Record<string, string[]>
  version?: string
  yolo?: boolean
  [key: string]: unknown
}

export interface HermesSessionOpenResult {
  info?: HermesSessionRuntimeInfo
  message_count: number
  messages: HermesMessage[]
  resumed?: StoredSessionId
  session_id: LiveSessionId
  stored_session_id?: StoredSessionId
  [key: string]: unknown
}

export interface CreateSessionParams extends JsonObject {
  close_on_disconnect?: boolean
  cols?: number
  cwd?: string
  fast?: boolean
  messages?: JsonValue[]
  model?: string
  parent_session_id?: StoredSessionId
  profile?: ProfileName
  provider?: string
  reasoning_effort?: string
  source?: string
  title?: string
}

export interface ResumeSessionParams extends JsonObject {
  close_on_disconnect?: boolean
  cols?: number
  eager_build?: boolean
  lazy?: boolean
  profile?: ProfileName
  session_id: StoredSessionId
  source?: string
}

export interface HermesSkill {
  category: string
  description: string
  enabled: boolean
  name: string
  provenance?: 'agent' | 'bundled' | 'hub'
  usage?: number
  [key: string]: unknown
}

export interface HermesMemoryProviderStatus {
  configured: boolean
  description: string
  name: string
  [key: string]: unknown
}

export interface HermesMemoryStatus {
  active: string
  builtin_files: { memory: number; user: number }
  providers: HermesMemoryProviderStatus[]
}

export type HermesKanbanStatus =
  | 'archived'
  | 'blocked'
  | 'done'
  | 'ready'
  | 'review'
  | 'running'
  | 'scheduled'
  | 'todo'
  | 'triage'
  | (string & {})

export interface HermesKanbanTask {
  assignee: null | ProfileName
  body: null | string
  completed_at: null | number
  created_at: number
  created_by: null | string
  id: string
  latest_summary?: null | string
  priority: number
  result: null | string
  session_id?: null | StoredSessionId
  started_at: null | number
  status: HermesKanbanStatus
  tenant: null | string
  title: string
  workspace_kind: string
  workspace_path: null | string
  [key: string]: unknown
}

export interface HermesKanbanColumn {
  name: HermesKanbanStatus
  tasks: HermesKanbanTask[]
}

export interface HermesKanbanBoard {
  assignees: ProfileName[]
  columns: HermesKanbanColumn[]
  latest_event_id: number
  now: number
  tenants: string[]
}

export interface HermesKanbanEvent {
  created_at: number
  id: number
  kind: string
  payload: JsonValue
  run_id: null | number
  task_id: string
}

export type HermesGatewayEventName =
  | 'approval.request'
  | 'background.complete'
  | 'clarify.request'
  | 'error'
  | 'gateway.ready'
  | 'message.complete'
  | 'message.delta'
  | 'message.start'
  | 'reasoning.available'
  | 'reasoning.delta'
  | 'secret.request'
  | 'session.info'
  | 'status.update'
  | 'sudo.request'
  | 'thinking.delta'
  | 'tool.complete'
  | 'tool.generating'
  | 'tool.progress'
  | 'tool.start'
  | (string & {})

export interface HermesGatewayEvent<TPayload = unknown> {
  payload?: TPayload
  profile?: ProfileName
  session_id?: LiveSessionId
  type: HermesGatewayEventName
}

export interface HermesRpcErrorShape {
  code?: number
  data?: unknown
  message: string
}

export interface HermesRpcRequestFrame {
  id: number | string
  jsonrpc: '2.0'
  method: string
  params?: JsonObject
}

export interface HermesRpcResponseFrame<TResult = unknown> {
  error?: HermesRpcErrorShape
  id: number | string | null
  jsonrpc: '2.0'
  result?: TResult
}

export interface HermesRpcEventFrame {
  jsonrpc: '2.0'
  method: 'event'
  params: HermesGatewayEvent
}

export interface HermesRpcMethodMap {
  'approval.respond': {
    params: JsonObject & { choice: string; session_id: LiveSessionId }
    result: { resolved: boolean }
  }
  'clarify.respond': {
    params: JsonObject & { answer: string; request_id: string }
    result: { status: string }
  }
  'prompt.submit': {
    params: JsonObject & { session_id: LiveSessionId; text: string }
    result: { status: string }
  }
  'secret.respond': {
    params: JsonObject & { request_id: string; value: string }
    result: { status: string }
  }
  'session.close': {
    params: JsonObject & { session_id: LiveSessionId }
    result: { closed: boolean }
  }
  'session.create': { params: CreateSessionParams; result: HermesSessionOpenResult }
  'session.interrupt': {
    params: JsonObject & { session_id: LiveSessionId }
    result: { status: string }
  }
  'session.resume': { params: ResumeSessionParams; result: HermesSessionOpenResult }
  'sudo.respond': {
    params: JsonObject & { password: string; request_id: string }
    result: { status: string }
  }
}

export type HermesKnownRpcMethod = keyof HermesRpcMethodMap
export type HermesRpcParams<TMethod extends HermesKnownRpcMethod> =
  HermesRpcMethodMap[TMethod]['params']
export type HermesRpcResult<TMethod extends HermesKnownRpcMethod> =
  HermesRpcMethodMap[TMethod]['result']
