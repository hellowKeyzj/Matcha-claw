export type SDKControlRequest = {
  type: 'control_request'
  request_id: string
  request: { subtype: string; [key: string]: unknown }
}

export type SDKControlResponse = {
  type: 'control_response'
  response:
    | {
        subtype: 'success'
        request_id: string
        response?: unknown
      }
    | {
        subtype: 'error'
        request_id: string
        error: string
      }
}

export type SDKMessage = { type: string; [key: string]: unknown }
export type SDKUserMessage = {
  type: 'user'
  content: string | Array<{ type: string; [key: string]: unknown }>
  uuid: string
  message?: {
    role?: string
    id?: string
    content?: unknown
    usage?: Record<string, unknown>
    [key: string]: unknown
  }
  tool_use_result?: unknown
  timestamp?: string
  [key: string]: unknown
}
export type SDKResultMessage = {
  type: 'result'
  subtype?: string
  errors?: string[]
  result?: string
  uuid?: string
  [key: string]: unknown
}
export type SDKSessionInfo = {
  sessionId: string
  summary?: string
  [key: string]: unknown
}
export type McpServerStatus = {
  name: string
  status: 'connected' | 'disconnected' | 'error'
  [key: string]: unknown
}
export type PermissionMode = string
export type OutputFormat = {
  type: 'json_schema'
  schema: Record<string, unknown>
}
export type ThinkingConfig = { type: string; [key: string]: unknown }
export type AgentDefinition = { [key: string]: unknown }
export type McpStdioServerConfig = {
  command: string
  args: string[]
  type: 'stdio'
  env?: Record<string, string>
}
export type McpSSEServerConfig = {
  type: 'sse'
  url: string
  [key: string]: unknown
}
export type McpHttpServerConfig = {
  type: 'http'
  url: string
  [key: string]: unknown
}

export type SandboxNetworkConfig = {
  allowedDomains?: string[]
  allowManagedDomainsOnly?: boolean
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  allowLocalBinding?: boolean
  httpProxyPort?: number
  socksProxyPort?: number
}
export type SandboxFilesystemConfig = {
  allowWrite?: string[]
  denyWrite?: string[]
  denyRead?: string[]
  allowRead?: string[]
  allowManagedReadPathsOnly?: boolean
}
export type SandboxSettings = {
  enabled?: boolean
  failIfUnavailable?: boolean
  autoAllowBashIfSandboxed?: boolean
  allowUnsandboxedCommands?: boolean
  network?: SandboxNetworkConfig
  filesystem?: SandboxFilesystemConfig
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  enableWeakerNetworkIsolation?: boolean
  excludedCommands?: string[]
  ripgrep?: { command: string; args?: string[] }
  [key: string]: unknown
}
export type SandboxIgnoreViolations = NonNullable<
  SandboxSettings['ignoreViolations']
>

export type Settings = Record<string, unknown>
export type AnyZodRawShape = Record<string, unknown>
export type InferShape<T extends AnyZodRawShape> = { [K in keyof T]: unknown }
export type SdkToolHandlerExtra = {
  signal?: AbortSignal
  toolUseId?: string
  serverName?: string
}
export type SdkMcpToolResult = {
  content: Array<{ type: string; [key: string]: unknown }>
  isError?: boolean
  [key: string]: unknown
}
type SdkMcpToolHandler<T extends AnyZodRawShape> = {
  bivarianceHack(
    args: InferShape<T>,
    extra: SdkToolHandlerExtra,
  ): Promise<SdkMcpToolResult>
}['bivarianceHack']
export type SdkMcpToolDefinition<T extends AnyZodRawShape = AnyZodRawShape> = {
  name: string
  description: string
  inputSchema: T
  handler: SdkMcpToolHandler<T>
  annotations?: Record<string, unknown>
  searchHint?: string
  alwaysLoad?: boolean
  [key: string]: unknown
}
export type McpSdkServerConfigWithInstance = {
  type: 'sdk'
  name: string
  version?: string
  tools: SdkMcpToolDefinition[]
  [key: string]: unknown
}
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance
  | Record<string, unknown>

export type CanUseToolRequest = {
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  permissionSuggestions?: unknown[]
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  agentId?: string
  description?: string
}
export type CanUseToolResponse =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }
  | { behavior: 'ask'; message?: string }
  | Record<string, unknown>
export type HookCallback = (input: {
  callbackId: string
  hookInput: unknown
  toolUseId?: string
}) => Promise<unknown>
export type ElicitationCallback = (input: {
  serverName: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitationId?: string
  requestedSchema?: Record<string, unknown>
}) => Promise<{
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}>

export type Options = {
  cwd?: string
  executable?: string
  pathToMatchaExecutable?: string
  env?: Record<string, string | undefined>
  model?: string
  systemPrompt?: string
  appendSystemPrompt?: string
  permissionMode?: PermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, McpServerConfig>
  sdkMcpServers?: McpSdkServerConfigWithInstance[]
  hooks?: Record<string, unknown>
  agents?: Record<string, AgentDefinition>
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: number
  thinkingConfig?: ThinkingConfig
  outputFormat?: 'text' | 'json' | 'stream-json' | OutputFormat
  includePartialMessages?: boolean
  resume?: string
  continue?: boolean
  forkSession?: boolean
  abortController?: AbortController
  canUseTool?: (request: CanUseToolRequest) => Promise<CanUseToolResponse>
  hookCallback?: HookCallback
  onElicitation?: ElicitationCallback
  jsonSchema?: Record<string, unknown>
  promptSuggestions?: boolean
  agentProgressSummaries?: boolean
}
export interface InternalOptions extends Options {
  [key: string]: unknown
}
export type ReadFileOptions = {
  maxBytes?: number
  encoding?: BufferEncoding
}
export type ReadFileResult = {
  contents: string
  absPath: string
  truncated?: boolean
  mtime?: number
}
export type ReadFileContentOptions = {
  offset?: number
  limit?: number
  pages?: string
  maxTokens?: number
  maxSizeBytes?: number
}
export type ReadFileContentBlock = { type: string; [key: string]: unknown }
export type ReadFileContent =
  | {
      type: 'text'
      file: {
        filePath: string
        content: string
        numLines: number
        startLine: number
        totalLines: number
      }
    }
  | {
      type: 'image'
      file: {
        base64: string
        type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
        originalSize: number
        dimensions?: Record<string, number | undefined>
      }
    }
  | { type: 'notebook'; file: { filePath: string; cells: unknown[] } }
  | {
      type: 'pdf'
      file: { filePath: string; base64: string; originalSize: number }
    }
  | {
      type: 'parts'
      file: {
        filePath: string
        originalSize: number
        count: number
        outputDir: string
      }
    }
  | { type: 'file_unchanged'; file: { filePath: string } }
export type ReadFileContentResult = {
  data: ReadFileContent
  content: string | ReadFileContentBlock[]
  supplementalContent?: Array<string | ReadFileContentBlock[]>
  toolUseId: string
}
export type McpAuthenticateResult = {
  authUrl?: string
  requiresUserAction: boolean
}
export type ClaudeAuthenticateResult = {
  manualUrl: string
  automaticUrl: string
}
export type RemoteControlResult = {
  session_url?: string
  connect_url?: string
  environment_id?: string
}

export interface Query extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  initializationResult(): Promise<unknown>
  supportedCommands(): Promise<unknown[]>
  supportedModels(): Promise<unknown[]>
  supportedAgents(): Promise<unknown[]>
  mcpServerStatus(): Promise<{ mcpServers: McpServerStatus[] }>
  getContextUsage(): Promise<unknown>
  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult>
  readFileContent(
    path: string,
    options?: ReadFileContentOptions,
  ): Promise<ReadFileContentResult>
  reloadPlugins(): Promise<unknown>
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<unknown>
  seedReadState(path: string, mtime: number): Promise<void>
  reconnectMcpServer(serverName: string): Promise<void>
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>
  enableChannel(serverName: string): Promise<void>
  authenticateMcpServer(serverName: string): Promise<McpAuthenticateResult>
  submitMcpOAuthCallbackUrl(
    serverName: string,
    callbackUrl: string,
  ): Promise<void>
  clearMcpAuth(serverName: string): Promise<void>
  authenticateClaude(options?: {
    loginWithClaudeAi?: boolean
  }): Promise<ClaudeAuthenticateResult>
  submitClaudeOAuthCallback(input: {
    authorizationCode: string
    state: string
  }): Promise<void>
  waitForClaudeOAuthCompletion(): Promise<unknown>
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<unknown>
  generateSessionTitle(
    description: string,
    options?: { persist?: boolean },
  ): Promise<{ title: string | null }>
  sideQuestion(question: string): Promise<{ response: string }>
  setProactive(enabled: boolean): Promise<void>
  remoteControl(enabled: boolean): Promise<RemoteControlResult>
  streamInput(input: SDKUserMessage): Promise<void>
  stopTask(taskId: string): Promise<void>
  backgroundTasks(toolUseId?: string): Promise<unknown>
  close(): Promise<void>
}
export interface InternalQuery extends Query {
  [key: string]: unknown
}

export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}
export type ForkSessionResult = { sessionId: string }
export type GetSessionInfoOptions = { dir?: string }
export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}
export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}
export type SessionMutationOptions = { dir?: string }
export type SessionMessage = {
  role: string
  content: unknown
  uuid?: string
  parentUuid?: string
  timestamp?: string
  type?: string
  [key: string]: unknown
}
export interface SDKSession {
  sessionId: string
  prompt(
    input: string | AsyncIterable<SDKUserMessage>,
  ): Promise<SDKResultMessage>
  abort(): void
}
export type SDKSessionOptions = Options & { sessionId?: string }
export type SessionApiInfo = SDKSessionInfo
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type CreateSdkMcpServerOptions = {
  name: string
  version?: string
  tools?: SdkMcpToolDefinition[]
}
export declare function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: SdkMcpToolDefinition<Schema>['handler'],
  extras?: Pick<
    SdkMcpToolDefinition,
    'annotations' | 'searchHint' | 'alwaysLoad'
  >,
): SdkMcpToolDefinition<Schema>
export declare function createSdkMcpServer(
  options: CreateSdkMcpServerOptions,
): McpSdkServerConfigWithInstance

export declare class AbortError extends Error {
  constructor(message?: string)
}
export declare function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
}): InternalQuery
export declare function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
export declare function unstable_v2_prompt(
  message: string,
  options: Options,
): Promise<SDKResultMessage>
export declare function unstable_v2_createSession(
  options?: SDKSessionOptions,
): SDKSession
export declare function unstable_v2_resumeSession(
  sessionId: string,
  options?: SDKSessionOptions,
): SDKSession
export declare function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]>
export declare function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined>
export declare function listSessions(
  options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]>
export declare function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions,
): Promise<void>
export declare function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions,
): Promise<void>
export declare function forkSession(
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult>

export type CronJitterConfig = {
  recurringFrac: number
  recurringCapMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
  recurringMaxAgeMs: number
}
export type CronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  lastFiredAt?: number
  recurring?: boolean
  permanent?: boolean
  durable?: boolean
  agentId?: string
}
export type ScheduledTaskEvent =
  | { type: 'fire'; task: CronTask }
  | { type: 'missed'; tasks: CronTask[] }
export type ScheduledTasksHandle = {
  events(): AsyncGenerator<ScheduledTaskEvent>
  getNextFireTime(): number | null
}
export declare function watchScheduledTasks(opts: {
  dir: string
  signal: AbortSignal
  getJitterConfig?: () => CronJitterConfig
}): ScheduledTasksHandle
export declare function buildMissedTaskNotification(missed: CronTask[]): string

export type InboundPrompt = {
  content: string | unknown[]
  uuid?: string
}
export type ConnectRemoteControlOptions = {
  dir: string
  name?: string
  workerType?: string
  branch?: string
  gitRepoUrl?: string | null
  getAccessToken: () => string | undefined
  baseUrl: string
  orgUUID: string
  model: string
}
export type RemoteControlHandle = {
  sessionUrl: string
  environmentId: string
  bridgeSessionId: string
  write(msg: SDKMessage): void
  sendResult(): void
  sendControlRequest(req: unknown): void
  sendControlResponse(res: unknown): void
  sendControlCancelRequest(requestId: string): void
  inboundPrompts(): AsyncGenerator<InboundPrompt>
  controlRequests(): AsyncGenerator<unknown>
  permissionResponses(): AsyncGenerator<unknown>
  onStateChange(
    cb: (
      state: 'ready' | 'connected' | 'reconnecting' | 'failed',
      detail?: string,
    ) => void,
  ): void
  teardown(): Promise<void>
}
export declare function connectRemoteControl(
  opts: ConnectRemoteControlOptions,
): Promise<RemoteControlHandle | null>

export declare const HOOK_EVENTS: readonly [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
]
export declare const EXIT_REASONS: readonly [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
]
export type HookEvent = (typeof HOOK_EVENTS)[number]
export type ExitReason = (typeof EXIT_REASONS)[number]
