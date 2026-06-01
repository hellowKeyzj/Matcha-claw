import { z } from 'zod/v4'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'
export declare const inputSchema: () => z.ZodObject<
  {
    server: z.ZodString
    uri: z.ZodString
  },
  z.core.$strip
>
type InputSchema = ReturnType<typeof inputSchema>
export declare const outputSchema: () => z.ZodObject<
  {
    contents: z.ZodArray<
      z.ZodObject<
        {
          uri: z.ZodString
          mimeType: z.ZodOptional<z.ZodString>
          text: z.ZodOptional<z.ZodString>
          blobSavedTo: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const ReadMcpResourceTool: Omit<
  {
    isConcurrencySafe(): true
    isReadOnly(): true
    toAutoClassifierInput(input: { server: string; uri: string }): string
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
        server: string
        uri: string
      },
      { options: { mcpClients } }: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: {
        contents: (
          | {
              uri: string
              mimeType: string | undefined
              text: string
              blobSavedTo?: undefined
            }
          | {
              uri: string
              mimeType: string | undefined
              text?: undefined
              blobSavedTo?: undefined
            }
          | {
              uri: string
              mimeType: string | undefined
              blobSavedTo: string
              text: string
            }
        )[]
      }
    }>
    renderToolUseMessage: typeof renderToolUseMessage
    userFacingName: typeof userFacingName
    renderToolResultMessage: typeof renderToolResultMessage
    isResultTruncated(output: Output): boolean
    mapToolResultToToolResultBlockParam(
      content: {
        contents: {
          uri: string
          mimeType?: string | undefined
          text?: string | undefined
          blobSavedTo?: string | undefined
        }[]
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
  userFacingName: typeof userFacingName
  isConcurrencySafe: () => true
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      [key: string]: unknown
    },
    _ctx?: import('src/Tool.js').ToolUseContext,
  ) => Promise<import('src/types/permissions.js').PermissionResult>
  toAutoClassifierInput: (input: { server: string; uri: string }) => string
}
export {}
