import { z } from 'zod/v4'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
declare const inputSchema: () => z.ZodObject<
  {
    url: z.ZodString
    prompt: z.ZodString
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    bytes: z.ZodNumber
    code: z.ZodNumber
    codeText: z.ZodString
    result: z.ZodString
    durationMs: z.ZodNumber
    url: z.ZodString
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const WebFetchTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    shouldDefer: true
    description(input: { url: string; prompt: string }): Promise<string>
    userFacingName(): string
    getToolUseSummary: typeof getToolUseSummary
    getActivityDescription(
      input:
        | Partial<{
            url: string
            prompt: string
          }>
        | undefined,
    ): string
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    isConcurrencySafe(): true
    isReadOnly(): true
    toAutoClassifierInput(input: { url: string; prompt: string }): string
    checkPermissions(
      input: {
        url: string
        prompt: string
      },
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<PermissionDecision>
    prompt(_options: {
      getToolPermissionContext: () => Promise<
        import('src/Tool.js').ToolPermissionContext
      >
      tools: import('src/Tool.js').Tools
      agents: import('../AgentTool/loadAgentsDir.js').AgentDefinition[]
      allowedAgentTypes?: string[]
    }): Promise<string>
    validateInput(input: { url: string; prompt: string }): Promise<
      | {
          result: false
          message: string
          meta: {
            reason: string
          }
          errorCode: number
        }
      | {
          result: true
          message?: undefined
          meta?: undefined
          errorCode?: undefined
        }
    >
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolUseProgressMessage: typeof renderToolUseProgressMessage
    renderToolResultMessage: typeof renderToolResultMessage
    call(
      {
        url,
        prompt,
      }: {
        url: string
        prompt: string
      },
      {
        abortController,
        options: { isNonInteractiveSession },
      }: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: {
        bytes: number
        code: number
        codeText: string
        result: string
        durationMs: number
        url: string
      }
    }>
    mapToolResultToToolResultBlockParam(
      {
        result,
      }: {
        bytes: number
        code: number
        codeText: string
        result: string
        durationMs: number
        url: string
      },
      toolUseID: string,
    ): {
      tool_use_id: string
      type: 'tool_result'
      content: string
    }
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
  userFacingName: () => string
  isConcurrencySafe: () => true
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      url: string
      prompt: string
    },
    context: import('src/Tool.js').ToolUseContext,
  ) => Promise<PermissionDecision>
  toAutoClassifierInput: (input: { url: string; prompt: string }) => string
}
export {}
