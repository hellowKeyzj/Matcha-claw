import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  AgentDefinition,
  McpServerStatus,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  OutputFormat,
  PermissionMode,
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKUserMessage,
  ThinkingConfig,
} from './coreTypes.js'

export type AnyZodRawShape = Record<string, unknown>
export type InferShape<T extends AnyZodRawShape> = { [K in keyof T]: unknown }

export type SdkToolHandlerExtra = {
  signal?: AbortSignal
  toolUseId?: string
  serverName?: string
}

type SdkMcpToolHandler<T extends AnyZodRawShape> = {
  bivarianceHack(
    args: InferShape<T>,
    extra: SdkToolHandlerExtra,
  ): Promise<CallToolResult>
}['bivarianceHack']

export interface SdkMcpToolDefinition<
  T extends AnyZodRawShape = AnyZodRawShape,
> {
  name: string
  description: string
  inputSchema: T
  handler: SdkMcpToolHandler<T>
  annotations?: ToolAnnotations
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

export type SDKSessionOptions = Options & {
  sessionId?: string
}

export type SessionApiInfo = SDKSessionInfo
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
