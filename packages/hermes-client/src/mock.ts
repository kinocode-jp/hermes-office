import type {
  HermesConnectionState,
  HermesGatewayEvent,
  HermesProfile,
  HermesRpcMethodMap,
  JsonObject,
  ProfileName
} from './types'
import {
  HermesTransportError,
  type HermesGatewayEventListener,
  type HermesHttpRequest,
  type HermesRequestOptions,
  type HermesRpcConnectOptions,
  type HermesRpcConnection,
  type HermesStateListener,
  type HermesStreamRequest,
  type HermesSubscription,
  type HermesTransport
} from './transport'

export interface MockHttpCall {
  profile?: ProfileName
  request: HermesHttpRequest
}

export interface MockRpcCall {
  method: string
  params: JsonObject
  profile?: ProfileName
}

export type MockHttpHandler = (request: HermesHttpRequest) => unknown | Promise<unknown>
export type MockRpcHandler = (
  params: JsonObject,
  context: { connection: MockHermesRpcConnection; profile?: ProfileName }
) => unknown | Promise<unknown>

class MockSubscription<TEvent> implements HermesSubscription {
  #closed = false
  readonly listener: (event: TEvent) => void
  readonly path: string

  constructor(path: string, listener: (event: TEvent) => void) {
    this.path = path
    this.listener = listener
  }

  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    this.#closed = true
  }

  emit(event: TEvent): void {
    if (!this.#closed) this.listener(event)
  }
}

export class MockHermesRpcConnection implements HermesRpcConnection {
  #closed = false
  #eventListeners = new Set<HermesGatewayEventListener>()
  #state: HermesConnectionState = 'open'
  #stateListeners = new Set<HermesStateListener>()

  readonly profile?: ProfileName
  readonly transport: MockHermesTransport

  constructor(transport: MockHermesTransport, profile?: ProfileName) {
    this.transport = transport
    if (profile !== undefined) this.profile = profile
  }

  get closed(): boolean {
    return this.#closed
  }

  get state(): HermesConnectionState {
    return this.#state
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#setState('closed')
  }

  emit(event: HermesGatewayEvent): void {
    if (this.#closed) return
    for (const listener of this.#eventListeners) listener(event)
  }

  onEvent(listener: HermesGatewayEventListener): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  onState(listener: HermesStateListener): () => void {
    this.#stateListeners.add(listener)
    listener(this.#state)
    return () => this.#stateListeners.delete(listener)
  }

  request<TMethod extends keyof HermesRpcMethodMap>(
    method: TMethod,
    params: HermesRpcMethodMap[TMethod]['params'],
    options?: HermesRequestOptions
  ): Promise<HermesRpcMethodMap[TMethod]['result']>
  request<TResult = unknown>(
    method: string,
    params?: JsonObject,
    options?: HermesRequestOptions
  ): Promise<TResult>
  async request<TResult = unknown>(
    method: string,
    params: JsonObject = {},
    options?: HermesRequestOptions
  ): Promise<TResult> {
    if (this.#closed) throw new HermesTransportError('Mock Hermes RPC connection is closed')
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return this.transport.handleRpc<TResult>(method, params, this)
  }

  #setState(state: HermesConnectionState): void {
    this.#state = state
    for (const listener of this.#stateListeners) listener(state)
  }
}

/** Programmable, dependency-free transport for UI development and tests. */
export class MockHermesTransport implements HermesTransport {
  readonly httpCalls: MockHttpCall[] = []
  readonly rpcCalls: MockRpcCall[] = []

  #httpHandlers = new Map<string, MockHttpHandler>()
  #online = true
  #rpcConnections = new Set<MockHermesRpcConnection>()
  #rpcHandlers = new Map<string, MockRpcHandler>()
  #subscriptions = new Set<MockSubscription<unknown>>()

  get online(): boolean {
    return this.#online
  }

  setOnline(online: boolean): void {
    this.#online = online
    if (!online) {
      for (const connection of this.#rpcConnections) connection.close()
      for (const subscription of this.#subscriptions) subscription.close()
    }
  }

  onHttp(method: HermesHttpRequest['method'], path: string, handler: MockHttpHandler): this {
    this.#httpHandlers.set(`${method} ${path}`, handler)
    return this
  }

  onRpc(method: string, handler: MockRpcHandler): this {
    this.#rpcHandlers.set(method, handler)
    return this
  }

  async connectRpc(options: HermesRpcConnectOptions = {}): Promise<MockHermesRpcConnection> {
    this.#assertAvailable(options)
    const connection = new MockHermesRpcConnection(this, options.profile)
    this.#rpcConnections.add(connection)
    return connection
  }

  async request<TResult, TBody = unknown>(
    request: HermesHttpRequest<TBody>,
    options: HermesRequestOptions = {}
  ): Promise<TResult> {
    this.#assertAvailable(options)
    const genericRequest = request as HermesHttpRequest
    const call: MockHttpCall = { request: genericRequest }
    if (options.profile !== undefined) call.profile = options.profile
    this.httpCalls.push(call)
    const handler = this.#httpHandlers.get(`${request.method} ${request.path}`)
    if (!handler) {
      throw new HermesTransportError(`No mock HTTP handler: ${request.method} ${request.path}`, {
        status: 404
      })
    }
    return (await handler(genericRequest)) as TResult
  }

  async subscribe<TEvent>(
    request: HermesStreamRequest,
    listener: (event: TEvent) => void,
    options: HermesRequestOptions = {}
  ): Promise<HermesSubscription> {
    this.#assertAvailable(options)
    const subscription = new MockSubscription<unknown>(request.path, event =>
      listener(event as TEvent)
    )
    this.#subscriptions.add(subscription)
    return subscription
  }

  emitGateway(event: HermesGatewayEvent, profile?: ProfileName): void {
    for (const connection of this.#rpcConnections) {
      if (!connection.closed && (profile === undefined || connection.profile === profile)) {
        connection.emit(event)
      }
    }
  }

  emitStream<TEvent>(path: string, event: TEvent): void {
    for (const subscription of this.#subscriptions) {
      if (subscription.path === path) subscription.emit(event)
    }
  }

  async handleRpc<TResult>(
    method: string,
    params: JsonObject,
    connection: MockHermesRpcConnection
  ): Promise<TResult> {
    this.#assertAvailable()
    const call: MockRpcCall = { method, params }
    if (connection.profile !== undefined) call.profile = connection.profile
    this.rpcCalls.push(call)
    const handler = this.#rpcHandlers.get(method)
    if (!handler) {
      throw new HermesTransportError(`unknown method: ${method}`, { code: -32601 })
    }
    const context: { connection: MockHermesRpcConnection; profile?: ProfileName } = { connection }
    if (connection.profile !== undefined) context.profile = connection.profile
    return (await handler(params, context)) as TResult
  }

  #assertAvailable(options?: HermesRequestOptions): void {
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!this.#online) throw new HermesTransportError('Mock Hermes backend is offline')
  }
}

/** Small useful fixture; callers can replace any handler with `onHttp`/`onRpc`. */
export function createDemoHermesTransport(): MockHermesTransport {
  const transport = new MockHermesTransport()
  const profiles: HermesProfile[] = [
    {
      description: 'Coordinates incoming work and delegates specialist tasks.',
      description_auto: false,
      gateway_running: true,
      has_alias: true,
      has_env: true,
      is_default: true,
      model: 'hermes-4-405b',
      name: 'default',
      path: '~/.hermes',
      provider: 'nous',
      skill_count: 12
    },
    {
      description: 'Builds and reviews product code.',
      description_auto: false,
      gateway_running: false,
      has_alias: true,
      has_env: true,
      is_default: false,
      model: 'gpt-5.3-codex',
      name: 'coder',
      path: '~/.hermes/profiles/coder',
      provider: 'openai-codex',
      skill_count: 8
    }
  ]

  transport
    .onHttp('GET', '/api/status', () => ({
      active_sessions: 0,
      auth_required: false,
      config_version: 7,
      gateway_running: true,
      gateway_state: 'running',
      latest_config_version: 7,
      profiles: profiles.map(profile => profile.name),
      release_date: '2026-07-07',
      version: '0.18.2'
    }))
    .onHttp('GET', '/api/profiles', () => ({ profiles }))
    .onHttp('GET', '/api/profiles/sessions', request => ({
      errors: [],
      limit: Number(request.query?.limit ?? 20),
      offset: Number(request.query?.offset ?? 0),
      profile_totals: { coder: 0, default: 0 },
      sessions: [],
      total: 0
    }))
    .onHttp('GET', '/api/skills', () => [])
    .onHttp('GET', '/api/memory', () => ({
      active: '',
      builtin_files: { memory: 0, user: 0 },
      providers: []
    }))
    .onHttp('GET', '/api/plugins/kanban/board', () => ({
      assignees: profiles.map(profile => profile.name),
      columns: ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'].map(
        name => ({ name, tasks: [] })
      ),
      latest_event_id: 0,
      now: Math.floor(Date.now() / 1000),
      tenants: []
    }))

  transport
    .onRpc('session.create', (params, { connection, profile }) => {
      const sessionId = `mock-${transport.rpcCalls.length}`
      const selectedProfile = String(params.profile ?? profile ?? 'default')
      queueMicrotask(() =>
        connection.emit({
          payload: { profile_name: selectedProfile },
          session_id: sessionId,
          type: 'session.info'
        })
      )
      return {
        info: { desktop_contract: 3, profile_name: selectedProfile },
        message_count: 0,
        messages: [],
        session_id: sessionId,
        stored_session_id: `stored-${sessionId}`
      }
    })
    .onRpc('session.resume', params => ({
      message_count: 0,
      messages: [],
      resumed: String(params.session_id),
      session_id: `live-${String(params.session_id)}`
    }))
    .onRpc('prompt.submit', (params, { connection }) => {
      const sessionId = String(params.session_id)
      queueMicrotask(() => {
        connection.emit({ session_id: sessionId, type: 'message.start' })
        connection.emit({ payload: { text: 'Mock Hermes is ready.' }, session_id: sessionId, type: 'message.delta' })
        connection.emit({ payload: { text: 'Mock Hermes is ready.' }, session_id: sessionId, type: 'message.complete' })
      })
      return { status: 'streaming' }
    })
    .onRpc('session.interrupt', () => ({ status: 'interrupted' }))
    .onRpc('session.close', () => ({ closed: true }))
    .onRpc('approval.respond', () => ({ resolved: true }))
    .onRpc('clarify.respond', () => ({ status: 'ok' }))
    .onRpc('sudo.respond', () => ({ status: 'ok' }))
    .onRpc('secret.respond', () => ({ status: 'ok' }))

  return transport
}
