import type { AssistantMessage } from 'src/types/message.js'
import { z } from 'zod/v4'
import { permissionModeSchema } from 'src/utils/permissions/PermissionMode.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import {
  renderGroupedAgentToolUse,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseTag,
  userFacingName,
  userFacingNameBackgroundColor,
} from './UI.js'
declare const baseInputSchema: () => z.ZodObject<
  {
    description: z.ZodString
    prompt: z.ZodString
    subagent_type: z.ZodOptional<z.ZodString>
    model: z.ZodOptional<
      z.ZodEnum<{
        haiku: 'haiku'
        sonnet: 'sonnet'
        opus: 'opus'
      }>
    >
    run_in_background: z.ZodOptional<z.ZodBoolean>
  },
  z.core.$strip
>
export declare const inputSchema: () => z.ZodObject<
  {
    model: z.ZodOptional<
      z.ZodEnum<{
        haiku: 'haiku'
        sonnet: 'sonnet'
        opus: 'opus'
      }>
    >
    name: z.ZodOptional<z.ZodString>
    description: z.ZodString
    mode: z.ZodOptional<
      z.ZodEnum<{
        default: 'default'
        auto: 'auto'
        acceptEdits: 'acceptEdits'
        bypassPermissions: 'bypassPermissions'
        plan: 'plan'
        dontAsk: 'dontAsk'
      }>
    >
    prompt: z.ZodString
    team_name: z.ZodOptional<z.ZodString>
    isolation: z.ZodOptional<
      z.ZodEnum<{
        worktree: 'worktree'
      }>
    >
    subagent_type: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type InputSchema = ReturnType<typeof inputSchema>
type AgentToolInput = z.infer<ReturnType<typeof baseInputSchema>> & {
  name?: string
  team_name?: string
  mode?: z.infer<ReturnType<typeof permissionModeSchema>>
  isolation?: 'worktree' | 'remote'
  cwd?: string
}
export declare const outputSchema: () => z.ZodUnion<
  readonly [
    z.ZodObject<
      {
        agentId: z.ZodString
        agentType: z.ZodOptional<z.ZodString>
        content: z.ZodArray<
          z.ZodObject<
            {
              type: z.ZodLiteral<'text'>
              text: z.ZodString
            },
            z.core.$strip
          >
        >
        totalToolUseCount: z.ZodNumber
        totalDurationMs: z.ZodNumber
        totalTokens: z.ZodNumber
        usage: z.ZodObject<
          {
            input_tokens: z.ZodNumber
            output_tokens: z.ZodNumber
            cache_creation_input_tokens: z.ZodNullable<z.ZodNumber>
            cache_read_input_tokens: z.ZodNullable<z.ZodNumber>
            server_tool_use: z.ZodNullable<
              z.ZodObject<
                {
                  web_search_requests: z.ZodNumber
                  web_fetch_requests: z.ZodNumber
                },
                z.core.$strip
              >
            >
            service_tier: z.ZodNullable<
              z.ZodEnum<{
                standard: 'standard'
                priority: 'priority'
                batch: 'batch'
              }>
            >
            cache_creation: z.ZodNullable<
              z.ZodObject<
                {
                  ephemeral_1h_input_tokens: z.ZodNumber
                  ephemeral_5m_input_tokens: z.ZodNumber
                },
                z.core.$strip
              >
            >
          },
          z.core.$strip
        >
        status: z.ZodLiteral<'completed'>
        prompt: z.ZodString
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        status: z.ZodLiteral<'async_launched'>
        agentId: z.ZodString
        description: z.ZodString
        prompt: z.ZodString
        outputFile: z.ZodString
        canReadOutputFile: z.ZodOptional<z.ZodBoolean>
      },
      z.core.$strip
    >,
  ]
>
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.input<OutputSchema>
export type RemoteLaunchedOutput = {
  status: 'remote_launched'
  taskId: string
  sessionUrl: string
  description: string
  prompt: string
  outputFile: string
}
import type { AgentToolProgress, ShellProgress } from 'src/types/tools.js'
export type Progress = AgentToolProgress | ShellProgress
export declare const AgentTool: Omit<
  {
    prompt({
      agents,
      tools,
      getToolPermissionContext,
      allowedAgentTypes,
    }: {
      getToolPermissionContext: () => Promise<
        import('src/Tool.js').ToolPermissionContext
      >
      tools: import('src/Tool.js').Tools
      agents: AgentDefinition[]
      allowedAgentTypes?: string[]
    }): Promise<string>
    name: string
    searchHint: string
    aliases: string[]
    maxResultSizeChars: number
    description(): Promise<string>
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    call(
      {
        prompt,
        subagent_type,
        description,
        model: modelParam,
        run_in_background,
        name,
        team_name,
        mode: spawnMode,
        isolation,
        cwd,
      }: AgentToolInput,
      toolUseContext: import('src/Tool.js').ToolUseContext,
      canUseTool: import('src/hooks/useCanUseTool.js').CanUseToolFn,
      assistantMessage: AssistantMessage,
      onProgress?: import('src/Tool.js').ToolCallProgress<any> | undefined,
    ): Promise<
      | {
          data: Output
        }
      | {
          data: {
            isAsync: true
            status: 'async_launched'
            agentId: string
            description: string
            prompt: string
            outputFile: string
            canReadOutputFile: boolean
          }
        }
    >
    isReadOnly(): true
    toAutoClassifierInput(input: {
      description: string
      prompt: string
      model?: 'haiku' | 'sonnet' | 'opus' | undefined
      name?: string | undefined
      mode?:
        | 'default'
        | 'auto'
        | 'acceptEdits'
        | 'bypassPermissions'
        | 'plan'
        | 'dontAsk'
        | undefined
      team_name?: string | undefined
      isolation?: 'worktree' | undefined
      subagent_type?: string | undefined
    }): string
    isConcurrencySafe(): true
    userFacingName: typeof userFacingName
    userFacingNameBackgroundColor: typeof userFacingNameBackgroundColor
    getActivityDescription(
      input:
        | Partial<{
            description: string
            prompt: string
            model?: 'haiku' | 'sonnet' | 'opus' | undefined
            name?: string | undefined
            mode?:
              | 'default'
              | 'auto'
              | 'acceptEdits'
              | 'bypassPermissions'
              | 'plan'
              | 'dontAsk'
              | undefined
            team_name?: string | undefined
            isolation?: 'worktree' | undefined
            subagent_type?: string | undefined
          }>
        | undefined,
    ): string
    checkPermissions(
      input: {
        description: string
        prompt: string
        model?: 'haiku' | 'sonnet' | 'opus' | undefined
        name?: string | undefined
        mode?:
          | 'default'
          | 'auto'
          | 'acceptEdits'
          | 'bypassPermissions'
          | 'plan'
          | 'dontAsk'
          | undefined
        team_name?: string | undefined
        isolation?: 'worktree' | undefined
        subagent_type?: string | undefined
      },
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<PermissionResult>
    mapToolResultToToolResultBlockParam(
      data:
        | {
            agentId: string
            content: {
              type: 'text'
              text: string
            }[]
            totalToolUseCount: number
            totalDurationMs: number
            totalTokens: number
            usage: {
              input_tokens: number
              output_tokens: number
              cache_creation_input_tokens: number | null
              cache_read_input_tokens: number | null
              server_tool_use: {
                web_search_requests: number
                web_fetch_requests: number
              } | null
              service_tier: 'standard' | 'priority' | 'batch' | null
              cache_creation: {
                ephemeral_1h_input_tokens: number
                ephemeral_5m_input_tokens: number
              } | null
            }
            status: 'completed'
            prompt: string
            agentType?: string | undefined
          }
        | {
            status: 'async_launched'
            agentId: string
            description: string
            prompt: string
            outputFile: string
            canReadOutputFile?: boolean | undefined
          },
      toolUseID: string,
    ): {
      tool_use_id: string
      type: 'tool_result'
      content: {
        type: 'text'
        text: string
      }[]
    }
    renderToolResultMessage: typeof renderToolResultMessage
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolUseTag: typeof renderToolUseTag
    renderToolUseProgressMessage: typeof renderToolUseProgressMessage
    renderToolUseRejectedMessage: typeof renderToolUseRejectedMessage
    renderToolUseErrorMessage: typeof renderToolUseErrorMessage
    renderGroupedToolUse: typeof renderGroupedAgentToolUse
  },
  | 'isEnabled'
  | 'userFacingName'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
> & {
  isEnabled: () => boolean
  userFacingName: typeof userFacingName
  isConcurrencySafe: () => true
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      description: string
      prompt: string
      model?: 'haiku' | 'sonnet' | 'opus' | undefined
      name?: string | undefined
      mode?:
        | 'default'
        | 'auto'
        | 'acceptEdits'
        | 'bypassPermissions'
        | 'plan'
        | 'dontAsk'
        | undefined
      team_name?: string | undefined
      isolation?: 'worktree' | undefined
      subagent_type?: string | undefined
    },
    context: import('src/Tool.js').ToolUseContext,
  ) => Promise<PermissionResult>
  toAutoClassifierInput: (input: {
    description: string
    prompt: string
    model?: 'haiku' | 'sonnet' | 'opus' | undefined
    name?: string | undefined
    mode?:
      | 'default'
      | 'auto'
      | 'acceptEdits'
      | 'bypassPermissions'
      | 'plan'
      | 'dontAsk'
      | undefined
    team_name?: string | undefined
    isolation?: 'worktree' | undefined
    subagent_type?: string | undefined
  }) => string
}
export {}
