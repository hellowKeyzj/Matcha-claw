import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
declare const inputSchema: () => z.ZodObject<
  {
    query: z.ZodString
    allowed_domains: z.ZodOptional<z.ZodArray<z.ZodString>>
    blocked_domains: z.ZodOptional<z.ZodArray<z.ZodString>>
    num_results: z.ZodOptional<z.ZodNumber>
    livecrawl: z.ZodOptional<
      z.ZodEnum<{
        fallback: 'fallback'
        preferred: 'preferred'
      }>
    >
    search_type: z.ZodOptional<
      z.ZodEnum<{
        auto: 'auto'
        fast: 'fast'
        deep: 'deep'
      }>
    >
    context_max_characters: z.ZodOptional<z.ZodNumber>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const searchResultSchema: () => z.ZodObject<
  {
    tool_use_id: z.ZodString
    content: z.ZodArray<
      z.ZodObject<
        {
          title: z.ZodString
          url: z.ZodString
          snippet: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
export type SearchResult = z.infer<ReturnType<typeof searchResultSchema>>
declare const outputSchema: () => z.ZodObject<
  {
    query: z.ZodString
    results: z.ZodArray<
      z.ZodUnion<
        readonly [
          z.ZodObject<
            {
              tool_use_id: z.ZodString
              content: z.ZodArray<
                z.ZodObject<
                  {
                    title: z.ZodString
                    url: z.ZodString
                    snippet: z.ZodOptional<z.ZodString>
                  },
                  z.core.$strip
                >
              >
            },
            z.core.$strip
          >,
          z.ZodString,
        ]
      >
    >
    durationSeconds: z.ZodNumber
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export type { WebSearchProgress } from 'src/types/tools.js'
export declare const WebSearchTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    shouldDefer: true
    description(input: {
      query: string
      allowed_domains?: string[] | undefined
      blocked_domains?: string[] | undefined
      num_results?: number | undefined
      livecrawl?: 'fallback' | 'preferred' | undefined
      search_type?: 'auto' | 'fast' | 'deep' | undefined
      context_max_characters?: number | undefined
    }): Promise<string>
    userFacingName(): string
    getToolUseSummary: typeof getToolUseSummary
    getActivityDescription(
      input:
        | Partial<{
            query: string
            allowed_domains?: string[] | undefined
            blocked_domains?: string[] | undefined
            num_results?: number | undefined
            livecrawl?: 'fallback' | 'preferred' | undefined
            search_type?: 'auto' | 'fast' | 'deep' | undefined
            context_max_characters?: number | undefined
          }>
        | undefined,
    ): string
    isEnabled(): true
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    isConcurrencySafe(): true
    isReadOnly(): true
    toAutoClassifierInput(input: {
      query: string
      allowed_domains?: string[] | undefined
      blocked_domains?: string[] | undefined
      num_results?: number | undefined
      livecrawl?: 'fallback' | 'preferred' | undefined
      search_type?: 'auto' | 'fast' | 'deep' | undefined
      context_max_characters?: number | undefined
    }): string
    checkPermissions(_input: {
      query: string
      allowed_domains?: string[] | undefined
      blocked_domains?: string[] | undefined
      num_results?: number | undefined
      livecrawl?: 'fallback' | 'preferred' | undefined
      search_type?: 'auto' | 'fast' | 'deep' | undefined
      context_max_characters?: number | undefined
    }): Promise<PermissionResult>
    prompt(): Promise<string>
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolUseProgressMessage: typeof renderToolUseProgressMessage
    renderToolResultMessage: typeof renderToolResultMessage
    extractSearchText(): string
    validateInput(input: {
      query: string
      allowed_domains?: string[] | undefined
      blocked_domains?: string[] | undefined
      num_results?: number | undefined
      livecrawl?: 'fallback' | 'preferred' | undefined
      search_type?: 'auto' | 'fast' | 'deep' | undefined
      context_max_characters?: number | undefined
    }): Promise<
      | {
          result: false
          message: string
          errorCode: number
        }
      | {
          result: true
          message?: undefined
          errorCode?: undefined
        }
    >
    call(
      input: {
        query: string
        allowed_domains?: string[] | undefined
        blocked_domains?: string[] | undefined
        num_results?: number | undefined
        livecrawl?: 'fallback' | 'preferred' | undefined
        search_type?: 'auto' | 'fast' | 'deep' | undefined
        context_max_characters?: number | undefined
      },
      context: import('src/Tool.js').ToolUseContext,
      _canUseTool: import('src/hooks/useCanUseTool.js').CanUseToolFn,
      _parentMessage: import('@ant/model-provider').AssistantMessage,
      onProgress: import('src/Tool.js').ToolCallProgress<any> | undefined,
    ): Promise<{
      data: {
        query: string
        results: (
          | string
          | {
              tool_use_id: string
              content: {
                title: string
                url: string
                snippet?: string | undefined
              }[]
            }
        )[]
        durationSeconds: number
      }
    }>
    mapToolResultToToolResultBlockParam(
      output: {
        query: string
        results: (
          | string
          | {
              tool_use_id: string
              content: {
                title: string
                url: string
                snippet?: string | undefined
              }[]
            }
        )[]
        durationSeconds: number
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
  isEnabled: () => true
  userFacingName: () => string
  isConcurrencySafe: () => true
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (_input: {
    query: string
    allowed_domains?: string[] | undefined
    blocked_domains?: string[] | undefined
    num_results?: number | undefined
    livecrawl?: 'fallback' | 'preferred' | undefined
    search_type?: 'auto' | 'fast' | 'deep' | undefined
    context_max_characters?: number | undefined
  }) => Promise<PermissionResult>
  toAutoClassifierInput: (input: {
    query: string
    allowed_domains?: string[] | undefined
    blocked_domains?: string[] | undefined
    num_results?: number | undefined
    livecrawl?: 'fallback' | 'preferred' | undefined
    search_type?: 'auto' | 'fast' | 'deep' | undefined
    context_max_characters?: number | undefined
  }) => string
}
