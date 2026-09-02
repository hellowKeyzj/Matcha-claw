import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID, type UUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Command } from '../../commands.js'
import type { QueryEngine } from '../../QueryEngine.js'
import type {
  QueryRunTraceStage,
  RunTraceDetails,
  RunTraceSink,
} from '../../query/runTrace.js'
import {
  isRunTraceEnabled,
  logProcessSessionTrace,
  sanitizeRunTraceDetails,
} from '../../query/runTrace.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from '../../services/mcp/types.js'
import type { AppState } from '../../state/AppStateStore.js'
import type {
  PermissionDecision,
  PermissionMode,
} from '../../types/permissions.js'
import { PERMISSION_MODES } from '../../types/permissions.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { isRecord } from '../protocol/jsonRpc.js'
import type {
  AppServerEvent,
  JsonObject,
  ProviderRuntimeConfig,
  StopReason,
  UsageSummary,
  WorkerApprovalDecision,
  WorkerApprovalRequest,
  WorkerInitializePayload,
  WorkerNotification,
} from '../protocol/types.js'
import { classifyWorkerError, errorToMessage } from './workerErrors.js'

type WorkerSessionSink = {
  emit(frame: WorkerNotification): void
}

type SDKMessage = Extract<AppServerEvent, { type: 'sdk.message' }>['sdkMessage']

type PendingApproval = {
  request: WorkerApprovalRequest
  resolve: (decision: WorkerApprovalDecision) => void
  reject: (error: Error) => void
}

type WorkerMcpBridgeResources = {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
}

type InitializeWorkerMcpBridgeOptions = {
  cwd: string
  getClaudeCodeMcpConfigs: () => Promise<{
    servers: Record<string, ScopedMcpServerConfig>
    errors: import('../../types/plugin.js').PluginError[]
  }>
  getMcpToolsCommandsAndResources: (
    onConnectionAttempt: (params: {
      client: MCPServerConnection
      tools: Tool[]
      commands: Command[]
      resources?: ServerResource[]
    }) => void,
    mcpConfigs?: Record<string, ScopedMcpServerConfig>,
  ) => Promise<void>
  getPluginErrorMessage: (
    error: import('../../types/plugin.js').PluginError,
  ) => string
}

export type WorkerSession = {
  readonly sessionId: string
  prompt(runId: string, prompt: string | ContentBlockParam[]): Promise<void>
  cancel(runId: string | undefined, reason: string): void
  respondToApproval(
    approvalId: string,
    decision: WorkerApprovalDecision,
  ): boolean
  flush(): Promise<void>
  setModel(model: string): void
  shutdown(reason: 'serverShutdown' | 'idleTimeout' | 'restart'): Promise<void>
}

async function initializeWorkerMcpBridge(
  options: InitializeWorkerMcpBridgeOptions,
): Promise<WorkerMcpBridgeResources> {
  try {
    const mcpConfigs = await options.getClaudeCodeMcpConfigs()
    for (const error of mcpConfigs.errors) {
      console.error(
        `[worker:mcp] config error cwd=${options.cwd} type=${error.type} source=${error.source}: ${options.getPluginErrorMessage(error)}`,
      )
    }

    return connectWorkerMcpServers(
      mcpConfigs.servers,
      options.getMcpToolsCommandsAndResources,
    )
  } catch (error) {
    const classified = classifyWorkerError(error, 'worker')
    console.error(
      `[worker:mcp] initialization failed cwd=${options.cwd} type=${classified.type} retryable=${classified.retryable}: ${classified.message}`,
    )
    throw error
  }
}

async function connectWorkerMcpServers(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
  getMcpToolsCommandsAndResources: InitializeWorkerMcpBridgeOptions['getMcpToolsCommandsAndResources'],
): Promise<WorkerMcpBridgeResources> {
  const resources: WorkerMcpBridgeResources = {
    clients: [],
    tools: [],
    commands: [],
    resources: {},
  }

  await getMcpToolsCommandsAndResources(result => {
    resources.clients.push(result.client)
    resources.tools = mergeByName(resources.tools, result.tools)
    resources.commands = mergeCommandsByName(
      resources.commands,
      result.commands,
    )
    if (result.resources && result.resources.length > 0) {
      resources.resources[result.client.name] = result.resources
    }
  }, mcpConfigs)

  return resources
}

function mergeCommandsByName(
  baseCommands: Command[],
  additionalCommands: Command[],
): Command[] {
  return mergeByName(baseCommands, additionalCommands)
}

function mergeByName<T extends { name: string }>(
  baseItems: T[],
  newItems: T[],
): T[] {
  const itemByName = new Map<string, T>()
  for (const item of baseItems) {
    itemByName.set(item.name, item)
  }
  for (const item of newItems) {
    if (!itemByName.has(item.name)) {
      itemByName.set(item.name, item)
    }
  }
  return Array.from(itemByName.values())
}

const HOST_MANAGED_PROVIDER_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_OPENAI_RESPONSES',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_MODE',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const

function prepareHostProviderRuntime(
  providerRuntime: ProviderRuntimeConfig | undefined,
): void {
  if (!providerRuntime) return
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
}

function applyHostProviderRuntime(
  providerRuntime: ProviderRuntimeConfig | undefined,
): void {
  if (!providerRuntime) return
  clearHostManagedProviderEnvironment()
  switch (providerRuntime.kind) {
    case 'anthropicMessages':
      applyOptionalEnv('ANTHROPIC_BASE_URL', providerRuntime.baseUrl)
      applyOptionalEnv('ANTHROPIC_API_KEY', providerRuntime.apiKey)
      return
    case 'googleGenerativeAi':
      process.env.CLAUDE_CODE_USE_GEMINI = '1'
      applyOptionalEnv('GEMINI_BASE_URL', providerRuntime.baseUrl)
      applyOptionalEnv('GEMINI_API_KEY', providerRuntime.apiKey)
      return
    case 'openAiChatCompletions':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOptionalEnv('OPENAI_BASE_URL', providerRuntime.baseUrl)
      applyOptionalEnv('OPENAI_API_KEY', providerRuntime.apiKey)
      return
    case 'openAiResponses':
      process.env.CLAUDE_CODE_USE_OPENAI_RESPONSES = '1'
      applyOptionalEnv('OPENAI_BASE_URL', providerRuntime.baseUrl)
      applyOptionalEnv('OPENAI_API_KEY', providerRuntime.apiKey)
      return
  }
}

function clearHostManagedProviderEnvironment(): void {
  for (const key of HOST_MANAGED_PROVIDER_ENV_KEYS) {
    delete process.env[key]
  }
}

function applyOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function providerRuntimeTraceDetails(
  providerRuntime: ProviderRuntimeConfig | undefined,
): RunTraceDetails {
  return {
    hasProviderRuntime: providerRuntime !== undefined,
    providerRuntimeKind: providerRuntime?.kind ?? null,
    hasBaseUrl: Boolean(providerRuntime?.baseUrl),
    hasApiKey: Boolean(providerRuntime?.apiKey),
  }
}

export async function createWorkerSession(
  payload: WorkerInitializePayload,
  sink: WorkerSessionSink,
): Promise<WorkerSession> {
  const [
    { QueryEngine },
    { getEmptyToolPermissionContext },
    { assembleToolPool },
    { getCommands },
    { getAgentDefinitionsWithOverrides },
    { getDefaultAppState },
    { FileStateCache },
    { hasPermissionsToUseTool },
    { getClaudeCodeMcpConfigs },
    { getMcpToolsCommandsAndResources },
    { getPluginErrorMessage },
    bootstrapState,
    managedEnv,
    settingsCache,
    { runWithCwdOverride },
    { resolveSessionFilePath },
    { getLastSessionLog },
    { deserializeMessages },
  ] = await Promise.all([
    import('../../QueryEngine.js'),
    import('../../Tool.js'),
    import('../../tools.js'),
    import('../../commands.js'),
    import('@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'),
    import('../../state/AppStateStore.js'),
    import('../../utils/fileStateCache.js'),
    import('../../utils/permissions/permissions.js'),
    import('../../services/mcp/config.js'),
    import('../../services/mcp/client.js'),
    import('../../types/plugin.js'),
    import('../../bootstrap/state.js'),
    import('../../utils/managedEnv.js'),
    import('../../utils/settings/settingsCache.js'),
    import('../../utils/cwd.js'),
    import('../../utils/sessionStoragePortable.js'),
    import('../../utils/sessionStorage.js'),
    import('../../utils/conversationRecovery.js'),
  ])

  const permissionContext = getEmptyToolPermissionContext()
  const permissionMode = resolvePermissionMode(payload.permissionMode)
  const appState: AppState = {
    ...getDefaultAppState(),
    toolPermissionContext: {
      ...permissionContext,
      mode: permissionMode,
    },
  }

  const resolvedSessionFile = await resolveSessionFilePath(
    payload.sessionId,
    payload.cwd,
  )
  bootstrapState.switchSession(
    payload.sessionId as import('../../types/ids.js').SessionId,
    resolvedSessionFile ? dirname(resolvedSessionFile.filePath) : null,
  )
  bootstrapState.setOriginalCwd(payload.cwd)
  settingsCache.resetSettingsCache()
  prepareHostProviderRuntime(payload.providerRuntime)
  managedEnv.applySafeConfigEnvironmentVariables()
  applyHostProviderRuntime(payload.providerRuntime)
  logProcessSessionTrace(
    'matcha-agent-worker',
    'worker.session.initialize.model',
    {
      sessionIdLength: payload.sessionId.length,
      model: payload.model ?? null,
      ...providerRuntimeTraceDetails(payload.providerRuntime),
    },
  )
  const restoredLog = resolvedSessionFile
    ? await getLastSessionLog(payload.sessionId as UUID)
    : null
  const initialMessages = restoredLog?.messages.length
    ? deserializeMessages(restoredLog.messages)
    : undefined

  return runWithCwdOverride(payload.cwd, async () => {
    const [commands, agentDefinitions, mcpSessionResources] = await Promise.all(
      [
        getCommands(payload.cwd),
        getAgentDefinitionsWithOverrides(payload.cwd),
        initializeWorkerMcpBridge({
          cwd: payload.cwd,
          getClaudeCodeMcpConfigs,
          getMcpToolsCommandsAndResources,
          getPluginErrorMessage,
        }),
      ],
    )
    const tools = assembleToolPool(
      appState.toolPermissionContext,
      mcpSessionResources.tools,
    )
    const mergedCommands = mergeCommandsByName(
      commands,
      mcpSessionResources.commands,
    )
    appState.agentDefinitions = agentDefinitions
    appState.mcp = {
      ...appState.mcp,
      clients: mcpSessionResources.clients,
      tools: mcpSessionResources.tools,
      commands: mcpSessionResources.commands,
      resources: mcpSessionResources.resources,
    }

    const session = new QueryEngineWorkerSession({
      sessionId: payload.sessionId,
      permissionMode,
      sink,
      hasPermissionsToUseTool,
    })

    const queryEngine = new QueryEngine({
      cwd: payload.cwd,
      tools,
      commands: mergedCommands,
      mcpClients: mcpSessionResources.clients,
      agents: agentDefinitions.activeAgents,
      canUseTool: session.canUseTool,
      getAppState: () => appState,
      setAppState: updater => {
        const updated = updater(appState)
        Object.assign(appState, updated)
      },
      readFileCache: new FileStateCache(500, 50 * 1024 * 1024),
      includePartialMessages: true,
      replayUserMessages: true,
      initialMessages,
      userSpecifiedModel: payload.model,
      runTrace: session.runTrace,
    })

    if (payload.model) {
      queryEngine.setModel(payload.model)
    }
    session.attachQueryEngine(queryEngine)
    return session
  })
}

type QueryEngineWorkerSessionOptions = {
  sessionId: string
  permissionMode: PermissionMode
  sink: WorkerSessionSink
  hasPermissionsToUseTool: CanUseToolFn
}

class QueryEngineWorkerSession implements WorkerSession {
  readonly sessionId: string
  readonly canUseTool: CanUseToolFn
  private readonly permissionMode: PermissionMode
  private readonly sink: WorkerSessionSink
  private readonly hasPermissionsToUseTool: CanUseToolFn
  readonly runTrace: RunTraceSink
  private queryEngine: QueryEngine | undefined
  private currentRunId: string | undefined
  private currentSdkAssistantMessageId: string | undefined
  private cancelReasonByRunId = new Map<string, string>()
  private pendingApprovals = new Map<string, PendingApproval>()

  constructor(options: QueryEngineWorkerSessionOptions) {
    this.sessionId = options.sessionId
    this.permissionMode = options.permissionMode
    this.sink = options.sink
    this.hasPermissionsToUseTool = options.hasPermissionsToUseTool
    this.canUseTool = this.createApprovalBridge()
    this.runTrace = this.createRunTraceSink()
  }

  attachQueryEngine(queryEngine: QueryEngine): void {
    this.queryEngine = queryEngine
  }

  async prompt(
    runId: string,
    prompt: string | ContentBlockParam[],
  ): Promise<void> {
    if (!this.queryEngine) {
      throw new Error('Worker session is not initialized')
    }

    this.currentRunId = runId
    this.currentSdkAssistantMessageId = undefined
    this.queryEngine.resetAbortController()
    this.sink.emit({
      type: 'event',
      runId,
      event: { type: 'run.started', runId, workerId: workerIdFromEnv() },
    })
    this.runTrace('worker.query.submit.started')

    try {
      for await (const sdkMessage of this.queryEngine.submitMessage(prompt)) {
        this.emitSdkMessage(runId, sdkMessage)
        const terminal = terminalResultFromSdkMessage(sdkMessage)
        if (!terminal) continue

        this.runTrace('worker.query.sdk_result', {
          isError: terminal.isError,
          stopReason: terminal.stopReason,
        })
        if (this.emitRunCancelledIfRequested(runId)) return
        if (terminal.isError) {
          this.emitRunFailed(runId, terminal.message)
          return
        }

        this.emitRunCompleted(runId, terminal.stopReason, terminal.usage)
        return
      }

      this.runTrace('worker.query.iterator.completed_without_result')
      if (this.emitRunCancelledIfRequested(runId)) return
      this.emitRunCompleted(runId, 'end_turn')
    } catch (error) {
      if (this.emitRunCancelledIfRequested(runId)) return

      this.runTrace('worker.query.error', errorTraceDetails(error))
      this.sink.emit({
        type: 'run.failed',
        runId,
        error: classifyWorkerError(error),
      })
    } finally {
      this.currentRunId = undefined
      this.currentSdkAssistantMessageId = undefined
      this.cancelReasonByRunId.delete(runId)
    }
  }

  cancel(runId: string | undefined, reason: string): void {
    const targetRunId = runId ?? this.currentRunId
    if (targetRunId) {
      this.cancelReasonByRunId.set(targetRunId, reason)
      this.sink.emit({
        type: 'event',
        runId: targetRunId,
        event: { type: 'run.cancelRequested', runId: targetRunId, reason },
      })
    }
    this.queryEngine?.interrupt()
    this.rejectAllApprovals(new Error(reason))
  }

  respondToApproval(
    approvalId: string,
    decision: WorkerApprovalDecision,
  ): boolean {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return false
    this.pendingApprovals.delete(approvalId)
    this.emitApprovalResolved(approvalId, pending.request, decision)
    pending.resolve(decision)
    return true
  }

  async flush(): Promise<void> {
    const { flushSessionStorage } = await import(
      '../../utils/sessionStorage.js'
    )
    await flushSessionStorage()
  }

  setModel(model: string): void {
    if (!this.queryEngine) {
      throw new Error('Worker session is not initialized')
    }
    this.queryEngine.setModel(model)
    logProcessSessionTrace(
      'matcha-agent-worker',
      'worker.session.setModel.applied',
      {
        sessionIdLength: this.sessionId.length,
        model,
      },
    )
  }

  async shutdown(
    reason: 'serverShutdown' | 'idleTimeout' | 'restart',
  ): Promise<void> {
    this.cancel(undefined, reason)
    await this.flush()
  }

  private createRunTraceSink(): RunTraceSink {
    return (stage: QueryRunTraceStage, details?: RunTraceDetails) => {
      if (!isRunTraceEnabled()) return
      const runId = this.currentRunId
      if (!runId) return

      const sanitizedDetails = sanitizeRunTraceDetails(details)
      if (
        stage === 'query_engine.model.resolved' ||
        stage === 'query.api.loop.start' ||
        stage === 'query.api.streaming.start' ||
        stage === 'api.request.sent' ||
        stage === 'api.response.headers' ||
        stage === 'api.stream.first_chunk' ||
        stage === 'api.stream.message_start' ||
        stage === 'api.stream.content_block_start' ||
        stage === 'api.stream.first_content_delta' ||
        stage === 'api.stream.first_text_delta' ||
        stage === 'api.stream.content_block_stop' ||
        stage === 'api.stream.message_delta.stop_reason' ||
        stage === 'api.stream.message_stop' ||
        stage === 'api.stream.watchdog.timeout' ||
        stage === 'api.stream.loop.end' ||
        stage === 'api.stream.error'
      ) {
        logProcessSessionTrace('matcha-agent-worker', stage, {
          sessionIdLength: this.sessionId.length,
          runId,
          ...(sanitizedDetails ?? {}),
        })
      }
      this.sink.emit({
        type: 'event',
        runId,
        event: {
          type: 'run.trace',
          runId,
          workerId: workerIdFromEnv(),
          stage,
          ...(sanitizedDetails ? { details: sanitizedDetails } : {}),
        },
      })
    }
  }

  private createApprovalBridge(): CanUseToolFn {
    return async (
      tool,
      input,
      context,
      assistantMessage,
      toolUseID,
      forceDecision,
    ): Promise<PermissionDecision<Record<string, unknown>>> => {
      if (forceDecision !== undefined) {
        return forceDecision
      }

      const pipelineDecision = await this.hasPermissionsToUseTool(
        tool,
        input,
        context,
        assistantMessage,
        toolUseID,
      )
      if (pipelineDecision.behavior !== 'ask') {
        return pipelineDecision
      }

      const approvalId = randomUUID()
      return this.requestApproval({
        approvalId,
        runId: this.currentRunId ?? 'unknown-run',
        toolCallId: toolUseID,
        toolName: tool.name,
        prompt: pipelineDecision.message,
        input: inputToJsonObject(pipelineDecision.updatedInput ?? input),
        options: [
          {
            optionId: 'allow_always',
            label: 'Always Allow',
            kind: 'allow_always',
          },
          { optionId: 'allow', label: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', label: 'Reject', kind: 'reject_once' },
          {
            optionId: 'reject_always',
            label: 'Always Reject',
            kind: 'reject_always',
          },
        ],
      })
    }
  }

  private async requestApproval(
    request: WorkerApprovalRequest,
  ): Promise<PermissionDecision<Record<string, unknown>>> {
    const approvalId = request.approvalId ?? randomUUID()
    const requestWithApprovalId: WorkerApprovalRequest = {
      ...request,
      approvalId,
    }
    const decisionPromise = new Promise<WorkerApprovalDecision>(
      (resolve, reject) => {
        this.pendingApprovals.set(approvalId, {
          request: requestWithApprovalId,
          resolve,
          reject,
        })
      },
    )

    this.sink.emit({ type: 'approval.request', request: requestWithApprovalId })
    this.sink.emit({
      type: 'event',
      runId: request.runId,
      event: {
        type: 'approval.requested',
        approval: {
          approvalId,
          sessionId: this.sessionId,
          runId: request.runId,
          workerId: workerIdFromEnv(),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          prompt: request.prompt,
          options: request.options,
          status: { type: 'pending', requestedAt: new Date().toISOString() },
        },
      },
    })

    try {
      const decision = await decisionPromise
      if (decision.type === 'approved') {
        return { behavior: 'allow', updatedInput: request.input }
      }
      if (decision.type === 'cancelled') {
        this.cancel(request.runId, decision.reason)
        return {
          behavior: 'deny',
          message: decision.reason,
          decisionReason: { type: 'mode', mode: this.permissionMode },
          toolUseID: request.toolCallId,
        }
      }
      return {
        behavior: 'deny',
        message: decision.reason ?? 'Permission denied by app-server client',
        decisionReason: { type: 'mode', mode: this.permissionMode },
        toolUseID: request.toolCallId,
      }
    } finally {
      this.pendingApprovals.delete(approvalId)
    }
  }

  private emitSdkMessage(runId: string, sdkMessage: SDKMessage): void {
    const projectionHints = this.projectionHintsForSdkMessage(sdkMessage)
    this.sink.emit({
      type: 'event',
      runId,
      event: {
        type: 'sdk.message',
        sdkMessageVersion: 'claude-code-sdk-message-v1',
        sdkMessage,
        ...(hasProjectionHints(projectionHints) ? { projectionHints } : {}),
      },
    })
  }

  private projectionHintsForSdkMessage(sdkMessage: SDKMessage): {
    messageId?: string
    toolCallId?: string
    isTerminal?: boolean
  } {
    if (!isRecord(sdkMessage)) return {}
    const hints: {
      messageId?: string
      toolCallId?: string
      isTerminal?: boolean
    } = {}
    const streamEvent = isRecord(sdkMessage.event)
      ? sdkMessage.event
      : undefined
    if (streamEvent?.type === 'message_start') {
      const message = isRecord(streamEvent.message)
        ? streamEvent.message
        : undefined
      this.currentSdkAssistantMessageId =
        stringField(message, 'id') ?? stringField(sdkMessage, 'uuid')
    }

    const isTerminalResult = sdkMessage.type === 'result'
    const messageId = isTerminalResult
      ? stringField(sdkMessage, 'uuid')
      : (this.currentSdkAssistantMessageId ?? stringField(sdkMessage, 'uuid'))
    if (messageId) hints.messageId = messageId
    const toolCallId = stringField(sdkMessage, 'tool_use_id')
    if (toolCallId) hints.toolCallId = toolCallId
    if (isTerminalResult) {
      hints.isTerminal = true
      this.currentSdkAssistantMessageId = undefined
    } else if (streamEvent?.type === 'message_stop') {
      this.currentSdkAssistantMessageId = undefined
    }
    return hints
  }

  private emitApprovalResolved(
    approvalId: string,
    request: WorkerApprovalRequest,
    decision: WorkerApprovalDecision,
  ): void {
    const resolvedAt = new Date().toISOString()
    this.sink.emit({
      type: 'event',
      runId: request.runId,
      event: {
        type: 'approval.resolved',
        approval: {
          approvalId,
          sessionId: this.sessionId,
          runId: request.runId,
          workerId: workerIdFromEnv(),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          prompt: request.prompt,
          options: request.options,
          status: approvalStatusFromDecision(decision, resolvedAt),
        },
      },
    })
  }

  private emitRunCancelledIfRequested(runId: string): boolean {
    const cancelReason = this.cancelReasonByRunId.get(runId)
    if (!cancelReason) return false

    this.runTrace('worker.query.cancelled', { reason: cancelReason })
    this.sink.emit({
      type: 'event',
      runId,
      event: { type: 'run.cancelled', runId, reason: cancelReason },
    })
    return true
  }

  private emitRunCompleted(
    runId: string,
    stopReason: StopReason,
    usage?: UsageSummary,
  ): void {
    this.sink.emit({ type: 'run.completed', runId, stopReason, usage })
  }

  private emitRunFailed(runId: string, message: string): void {
    this.sink.emit({
      type: 'run.failed',
      runId,
      error: classifyWorkerError(message),
    })
  }

  private rejectAllApprovals(error: Error): void {
    for (const [approvalId, pending] of this.pendingApprovals) {
      this.pendingApprovals.delete(approvalId)
      pending.reject(error)
    }
  }
}

function resolvePermissionMode(value: string | undefined): PermissionMode {
  if (value) {
    for (const mode of PERMISSION_MODES) {
      if (mode === value) return mode
    }
  }
  return 'default'
}

function inputToJsonObject(input: Record<string, unknown>): JsonObject {
  const jsonObject: JsonObject = {}
  for (const [key, value] of Object.entries(input)) {
    jsonObject[key] = value
  }
  return jsonObject
}

function errorTraceDetails(error: unknown): RunTraceDetails {
  if (error instanceof Error) {
    return { errorName: error.name }
  }
  return { errorName: typeof error }
}

function approvalStatusFromDecision(
  decision: WorkerApprovalDecision,
  resolvedAt: string,
): import('../protocol/types.js').ApprovalStatus {
  switch (decision.type) {
    case 'approved':
      return { type: 'approved', resolvedAt, optionId: decision.optionId }
    case 'denied':
      return { type: 'denied', resolvedAt, reason: decision.reason }
    case 'cancelled':
      return { type: 'cancelled', resolvedAt, reason: 'runCancelled' }
  }
}

type TerminalSdkResult = {
  isError: boolean
  message: string
  stopReason: StopReason
  usage?: UsageSummary
}

function terminalResultFromSdkMessage(
  sdkMessage: SDKMessage,
): TerminalSdkResult | undefined {
  if (!isRecord(sdkMessage) || sdkMessage.type !== 'result') return undefined

  const subtype =
    typeof sdkMessage.subtype === 'string' ? sdkMessage.subtype : undefined
  const stopReason = stopReasonFromSdkResult(subtype, sdkMessage.stop_reason)
  const usage = usageFromSdkResult(sdkMessage.usage)
  const isError =
    sdkMessage.is_error === true ||
    (subtype !== undefined && subtype !== 'success')
  return {
    isError,
    message: resultMessageFromSdkResult(sdkMessage),
    stopReason,
    usage,
  }
}

function stopReasonFromSdkResult(
  subtype: string | undefined,
  value: unknown,
): StopReason {
  if (subtype === 'error_max_turns') return 'max_turn_requests'
  if (typeof value !== 'string')
    return subtype === 'success' ? 'end_turn' : 'error'

  switch (value) {
    case 'end_turn':
    case 'max_tokens':
    case 'refusal':
      return value
    case 'max_turn_requests':
      return 'max_turn_requests'
    default:
      return subtype === 'success' ? 'end_turn' : 'error'
  }
}

function usageFromSdkResult(value: unknown): UsageSummary | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens =
    numberField(value, 'input_tokens') +
    numberField(value, 'cache_read_input_tokens') +
    numberField(value, 'cache_creation_input_tokens')
  const outputTokens = numberField(value, 'output_tokens')
  const cachedReadTokens = numberField(value, 'cache_read_input_tokens')
  const cachedWriteTokens = numberField(value, 'cache_creation_input_tokens')
  return {
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    totalTokens: inputTokens + outputTokens,
  }
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function resultMessageFromSdkResult(record: Record<string, unknown>): string {
  const errors = record.errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map(item => errorToMessage(item, 'Unknown SDK error'))
      .join('\n')
  }
  if (typeof record.result === 'string' && record.result.trim() !== '') {
    return record.result
  }
  return record.subtype === 'success' ? 'Run completed' : 'Run failed'
}

function hasProjectionHints(hints: {
  messageId?: string
  toolCallId?: string
  isTerminal?: boolean
}): boolean {
  return (
    hints.messageId !== undefined ||
    hints.toolCallId !== undefined ||
    hints.isTerminal !== undefined
  )
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function workerIdFromEnv(): string {
  return process.env.MATCHA_AGENT_WORKER_ID ?? 'matcha-agent-worker'
}
