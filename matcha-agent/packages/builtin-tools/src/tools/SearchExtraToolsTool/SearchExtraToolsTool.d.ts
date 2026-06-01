import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
export declare const inputSchema: () => z.ZodObject<
  {
    query: z.ZodString
    max_results: z.ZodDefault<z.ZodOptional<z.ZodNumber>>
  },
  z.core.$strip
>
type InputSchema = ReturnType<typeof inputSchema>
export declare const outputSchema: () => z.ZodObject<
  {
    matches: z.ZodArray<z.ZodString>
    query: z.ZodString
    total_deferred_tools: z.ZodNumber
    pending_mcp_servers: z.ZodOptional<z.ZodArray<z.ZodString>>
    already_loaded: z.ZodOptional<z.ZodArray<z.ZodString>>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare function clearSearchExtraToolsDescriptionCache(): void
export declare const SearchExtraToolsTool: Omit<
  {
    isEnabled(): boolean
    isConcurrencySafe(): true
    isReadOnly(): true
    name: string
    maxResultSizeChars: number
    description(): Promise<string>
    prompt(): Promise<string>
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    call(
      input: {
        query: string
        max_results: number
      },
      { options: { tools }, getAppState }: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: Output
    }>
    renderToolUseMessage(
      input: Partial<{
        query: string
        max_results: number
      }>,
    ): string | null
    userFacingName(): string
    /**
     * Returns a tool_result with text output guiding the model to use ExecuteExtraTool.
     * No longer uses tool_reference blocks — unified self-built tool search for all providers.
     */
    mapToolResultToToolResultBlockParam(
      content: Output,
      toolUseID: string,
      _context?: {
        mainLoopModel?: string
      },
    ): ToolResultBlockParam
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
      [key: string]: unknown
    },
    _ctx?: import('src/Tool.js').ToolUseContext,
  ) => Promise<import('src/types/permissions.js').PermissionResult>
  toAutoClassifierInput: (_input?: unknown) => string
}
export {}
