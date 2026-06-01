import { z } from 'zod/v4'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
declare const inputSchema: () => z.ZodObject<
  {
    server: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodArray<
  z.ZodObject<
    {
      uri: z.ZodString
      name: z.ZodString
      mimeType: z.ZodOptional<z.ZodString>
      description: z.ZodOptional<z.ZodString>
      server: z.ZodString
    },
    z.core.$strip
  >
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const ListMcpResourcesTool: Omit<
  {
    isConcurrencySafe(): true
    isReadOnly(): true
    toAutoClassifierInput(input: { server?: string | undefined }): string
    shouldDefer: true
    name: string
    searchHint: string
    maxResultSizeChars: number
    description(): Promise<string>
    prompt(): Promise<string>
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    call(
      input: {
        server?: string | undefined
      },
      { options: { mcpClients } }: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: import('src/services/mcp/types.js').ServerResource[]
    }>
    renderToolUseMessage: typeof renderToolUseMessage
    userFacingName: () => string
    renderToolResultMessage: typeof renderToolResultMessage
    isResultTruncated(output: Output): boolean
    mapToolResultToToolResultBlockParam(
      content: {
        uri: string
        name: string
        server: string
        mimeType?: string | undefined
        description?: string | undefined
      }[],
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
      [key: string]: unknown
    },
    _ctx?: import('src/Tool.js').ToolUseContext,
  ) => Promise<import('src/types/permissions.js').PermissionResult>
  toAutoClassifierInput: (input: { server?: string | undefined }) => string
}
export {}
