import { randomUUID } from 'node:crypto'
import type {
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from './coreTypes.js'
import type {
  SDKControlCancelRequest,
  SDKControlRequest,
  SDKControlResponse,
} from './controlTypes.js'
import { ControlHost } from './controlHost.js'
import { ProcessTransport } from './processTransport.js'
import type {
  InternalOptions,
  InternalQuery,
  ClaudeAuthenticateResult,
  McpAuthenticateResult,
  McpServerConfig,
  Options,
  Query,
  ReadFileContentOptions,
  ReadFileContentResult,
  ReadFileOptions,
  ReadFileResult,
  RemoteControlResult,
} from './runtimeTypes.js'

export class AbortError extends Error {
  constructor(message = 'The SDK query was aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

type QueueItem =
  | { type: 'message'; message: SDKMessage }
  | { type: 'error'; error: Error }
  | { type: 'done' }

type PendingControl = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

function isControlRequest(
  message:
    | SDKMessage
    | SDKControlRequest
    | SDKControlResponse
    | SDKControlCancelRequest,
): message is SDKControlRequest {
  return message.type === 'control_request' && 'request' in message
}

function isControlResponse(
  message:
    | SDKMessage
    | SDKControlRequest
    | SDKControlResponse
    | SDKControlCancelRequest,
): message is SDKControlResponse {
  return message.type === 'control_response' && 'response' in message
}

function isControlCancelRequest(
  message:
    | SDKMessage
    | SDKControlRequest
    | SDKControlResponse
    | SDKControlCancelRequest,
): message is SDKControlCancelRequest {
  return message.type === 'control_cancel_request' && 'request_id' in message
}

class MatchaQuery implements InternalQuery {
  [key: string]: unknown
  private readonly transport: ProcessTransport
  private readonly queue: QueueItem[] = []
  private readonly waiters: Array<(item: QueueItem) => void> = []
  private readonly pendingControls = new Map<string, PendingControl>()
  private readonly controlHost: ControlHost
  private readonly initializePromise: Promise<unknown>
  private initializeResolve!: (value: unknown) => void
  private initializeReject!: (error: Error) => void
  private initializeRequestId: string | undefined
  private closed = false

  constructor(
    prompt: string | AsyncIterable<SDKUserMessage>,
    options: Options = {},
  ) {
    this.initializePromise = new Promise((resolve, reject) => {
      this.initializeResolve = resolve
      this.initializeReject = reject
    })
    this.controlHost = new ControlHost(options, response => {
      this.transport.send(response as never)
    })
    this.transport = new ProcessTransport({
      prompt: typeof prompt === 'string' ? prompt : undefined,
      options,
      onInitializeRequestId: requestId => {
        this.initializeRequestId = requestId
      },
    })
    this.transport.onEvent(event => {
      if (event.type === 'message') {
        void this.handleStdoutMessage(
          event.message as
            | SDKMessage
            | SDKControlRequest
            | SDKControlResponse
            | SDKControlCancelRequest,
        )
      } else if (event.type === 'error') {
        this.fail(event.error)
      } else {
        this.finish()
      }
    })
    options.abortController?.signal.addEventListener('abort', () => {
      void this.interrupt()
    })
    this.transport.start()
    if (typeof prompt !== 'string') {
      void this.pipePrompt(prompt)
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      const item = await this.nextQueueItem()
      if (item.type === 'done') return
      if (item.type === 'error') throw item.error
      yield item.message
    }
  }

  async interrupt(): Promise<void> {
    await this.sendControlRequest({ subtype: 'interrupt' })
  }

  async setPermissionMode(
    mode: NonNullable<Options['permissionMode']>,
  ): Promise<void> {
    await this.sendControlRequest({ subtype: 'set_permission_mode', mode })
  }

  async setModel(model?: string): Promise<void> {
    await this.sendControlRequest({ subtype: 'set_model', model })
  }

  async setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    await this.sendControlRequest({
      subtype: 'set_max_thinking_tokens',
      max_thinking_tokens: maxThinkingTokens,
    })
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    await this.sendControlRequest({ subtype: 'apply_flag_settings', settings })
  }

  async initializationResult(): Promise<unknown> {
    return this.initializePromise
  }

  async supportedCommands(): Promise<unknown[]> {
    const result = (await this.initializationResult()) as {
      commands?: unknown[]
    }
    return result.commands ?? []
  }

  async supportedModels(): Promise<unknown[]> {
    const result = (await this.initializationResult()) as { models?: unknown[] }
    return result.models ?? []
  }

  async supportedAgents(): Promise<unknown[]> {
    const result = (await this.initializationResult()) as { agents?: unknown[] }
    return result.agents ?? []
  }

  async mcpServerStatus(): Promise<
    Query['mcpServerStatus'] extends () => Promise<infer T> ? T : never
  > {
    return (await this.sendControlRequest({
      subtype: 'mcp_status',
    })) as Query['mcpServerStatus'] extends () => Promise<infer T> ? T : never
  }

  async getContextUsage(): Promise<unknown> {
    return this.sendControlRequest({ subtype: 'get_context_usage' })
  }

  async readFile(
    path: string,
    options?: ReadFileOptions,
  ): Promise<ReadFileResult> {
    return (await this.sendControlRequest({
      subtype: 'read_file',
      path,
      maxBytes: options?.maxBytes,
      encoding: options?.encoding,
    })) as ReadFileResult
  }

  async readFileContent(
    path: string,
    options?: ReadFileContentOptions,
  ): Promise<ReadFileContentResult> {
    return (await this.sendControlRequest({
      subtype: 'read_file_content',
      path,
      offset: options?.offset,
      limit: options?.limit,
      pages: options?.pages,
      maxTokens: options?.maxTokens,
      maxSizeBytes: options?.maxSizeBytes,
    })) as ReadFileContentResult
  }

  async reloadPlugins(): Promise<unknown> {
    return this.sendControlRequest({ subtype: 'reload_plugins' })
  }

  async rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<unknown> {
    return this.sendControlRequest({
      subtype: 'rewind_files',
      user_message_id: userMessageId,
      dry_run: options?.dryRun,
    })
  }

  async seedReadState(path: string, mtime: number): Promise<void> {
    await this.sendControlRequest({ subtype: 'seed_read_state', path, mtime })
  }

  async reconnectMcpServer(serverName: string): Promise<void> {
    await this.sendControlRequest({ subtype: 'mcp_reconnect', serverName })
  }

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    await this.sendControlRequest({
      subtype: 'mcp_toggle',
      serverName,
      enabled,
    })
  }

  async enableChannel(serverName: string): Promise<void> {
    await this.sendControlRequest({ subtype: 'channel_enable', serverName })
  }

  async authenticateMcpServer(
    serverName: string,
  ): Promise<McpAuthenticateResult> {
    return (await this.sendControlRequest({
      subtype: 'mcp_authenticate',
      serverName,
    })) as McpAuthenticateResult
  }

  async submitMcpOAuthCallbackUrl(
    serverName: string,
    callbackUrl: string,
  ): Promise<void> {
    await this.sendControlRequest({
      subtype: 'mcp_oauth_callback_url',
      serverName,
      callbackUrl,
    })
  }

  async clearMcpAuth(serverName: string): Promise<void> {
    await this.sendControlRequest({ subtype: 'mcp_clear_auth', serverName })
  }

  async authenticateClaude(options?: {
    loginWithClaudeAi?: boolean
  }): Promise<ClaudeAuthenticateResult> {
    return (await this.sendControlRequest({
      subtype: 'claude_authenticate',
      loginWithClaudeAi: options?.loginWithClaudeAi,
    })) as ClaudeAuthenticateResult
  }

  async submitClaudeOAuthCallback(input: {
    authorizationCode: string
    state: string
  }): Promise<void> {
    await this.sendControlRequest({
      subtype: 'claude_oauth_callback',
      authorizationCode: input.authorizationCode,
      state: input.state,
    })
  }

  async waitForClaudeOAuthCompletion(): Promise<unknown> {
    return this.sendControlRequest({
      subtype: 'claude_oauth_wait_for_completion',
    })
  }

  async setMcpServers(
    servers: Record<string, McpServerConfig>,
  ): Promise<unknown> {
    return this.sendControlRequest({ subtype: 'mcp_set_servers', servers })
  }

  async generateSessionTitle(
    description: string,
    options?: { persist?: boolean },
  ): Promise<{ title: string | null }> {
    return (await this.sendControlRequest({
      subtype: 'generate_session_title',
      description,
      persist: options?.persist,
    })) as { title: string | null }
  }

  async sideQuestion(question: string): Promise<{ response: string }> {
    return (await this.sendControlRequest({
      subtype: 'side_question',
      question,
    })) as { response: string }
  }

  async setProactive(enabled: boolean): Promise<void> {
    await this.sendControlRequest({ subtype: 'set_proactive', enabled })
  }

  async remoteControl(enabled: boolean): Promise<RemoteControlResult> {
    return (await this.sendControlRequest({
      subtype: 'remote_control',
      enabled,
    })) as RemoteControlResult
  }

  async streamInput(input: SDKUserMessage): Promise<void> {
    this.transport.send(input as never)
  }

  async stopTask(taskId: string): Promise<void> {
    await this.sendControlRequest({ subtype: 'stop_task', task_id: taskId })
  }

  async backgroundTasks(toolUseId?: string): Promise<unknown> {
    return this.sendControlRequest({
      subtype: 'background_tasks',
      tool_use_id: toolUseId,
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.controlHost.close()
    this.transport.close()
    this.rejectPendingControls(new AbortError('The SDK query was closed'))
    this.push({ type: 'done' })
  }

  private async pipePrompt(
    prompt: AsyncIterable<SDKUserMessage>,
  ): Promise<void> {
    try {
      for await (const message of prompt) {
        if (this.closed) return
        await this.streamInput(message)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async handleStdoutMessage(
    message:
      | SDKMessage
      | SDKControlRequest
      | SDKControlResponse
      | SDKControlCancelRequest,
  ): Promise<void> {
    if (isControlRequest(message)) {
      await this.controlHost.handleControlRequest(message)
      return
    }

    if (isControlCancelRequest(message)) {
      this.controlHost.cancel(message)
      return
    }

    if (isControlResponse(message)) {
      this.resolveControlResponse(message)
      return
    }

    this.push({ type: 'message', message })
  }

  private resolveControlResponse(message: SDKControlResponse): void {
    const response = message.response
    const pending = this.pendingControls.get(response.request_id)
    if (!pending) {
      if (response.request_id === this.initializeRequestId) {
        if (response.subtype === 'error') {
          this.initializeReject(new Error(response.error))
        } else {
          this.initializeResolve(response.response ?? {})
        }
      }
      return
    }
    this.pendingControls.delete(response.request_id)
    if (response.subtype === 'error') {
      pending.reject(new Error(response.error))
    } else {
      pending.resolve(response.response ?? {})
    }
  }

  private sendControlRequest(
    request: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = randomUUID()
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingControls.set(requestId, { resolve, reject })
    })
    this.transport.send({
      type: 'control_request',
      request_id: requestId,
      request: request as never,
    })
    return promise
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.controlHost.close()
    this.rejectPendingControls(error)
    this.initializeReject(error)
    this.push({ type: 'error', error })
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.controlHost.close()
    this.rejectPendingControls(
      new Error(
        'SDK process exited before completing pending control requests',
      ),
    )
    this.push({ type: 'done' })
  }

  private rejectPendingControls(error: Error): void {
    for (const pending of this.pendingControls.values()) {
      pending.reject(error)
    }
    this.pendingControls.clear()
  }

  private push(item: QueueItem): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(item)
    } else {
      this.queue.push(item)
    }
  }

  private nextQueueItem(): Promise<QueueItem> {
    const item = this.queue.shift()
    if (item) return Promise.resolve(item)
    return new Promise(resolve => this.waiters.push(resolve))
  }
}

export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
}): InternalQuery
export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query {
  return new MatchaQuery(params.prompt, params.options)
}

export async function unstable_v2_prompt(
  message: string,
  options: Options,
): Promise<SDKResultMessage> {
  let lastResult: SDKResultMessage | undefined
  for await (const sdkMessage of query({ prompt: message, options })) {
    if (sdkMessage.type === 'result') {
      lastResult = sdkMessage as SDKResultMessage
    }
  }
  if (!lastResult)
    throw new Error('SDK query completed without a result message')
  return lastResult
}
