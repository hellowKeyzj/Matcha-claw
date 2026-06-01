import { z } from 'zod/v4'
import { type ToolUseContext } from 'src/Tool.js'
export declare const inputSchema: () => z.ZodObject<
  {
    tool_name: z.ZodString
    params: z.ZodRecord<z.ZodString, z.ZodUnknown>
  },
  z.core.$strip
>
type InputSchema = ReturnType<typeof inputSchema>
export declare const outputSchema: () => z.ZodObject<
  {
    result: z.ZodUnknown
    tool_name: z.ZodString
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const ExecuteTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    isConcurrencySafe(): false
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    description(): Promise<string>
    prompt(): Promise<string>
    call(
      input: {
        tool_name: string
        params: Record<string, unknown>
      },
      context: ToolUseContext,
      canUseTool: import('src/hooks/useCanUseTool.js').CanUseToolFn,
      parentMessage: import('@ant/model-provider').AssistantMessage,
      onProgress: import('src/Tool.js').ToolCallProgress<any> | undefined,
    ): Promise<{
      data: {
        result: unknown
        tool_name: string
      }
      newMessages?: (
        | import('@ant/model-provider').UserMessage
        | import('@ant/model-provider').AssistantMessage
        | import('@ant/model-provider').AttachmentMessage
        | import('@ant/model-provider').SystemMessage
      )[]
      contextModifier?: (context: ToolUseContext) => ToolUseContext
      mcpMeta?: {
        _meta?: Record<string, unknown>
        structuredContent?: Record<string, unknown>
      }
    }>
    checkPermissions(): Promise<{
      behavior: 'passthrough'
      message: string
    }>
    renderToolUseMessage(
      input: Partial<{
        tool_name: string
        params: Record<string, unknown>
      }>,
    ): string
    userFacingName(): string
    mapToolResultToToolResultBlockParam(
      content: {
        result: unknown
        tool_name: string
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
  isConcurrencySafe: () => false
  isReadOnly: (_input?: unknown) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: () => Promise<{
    behavior: 'passthrough'
    message: string
  }>
  toAutoClassifierInput: (_input?: unknown) => string
}
export {}
