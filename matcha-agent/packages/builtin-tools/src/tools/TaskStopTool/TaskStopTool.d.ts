import { z } from 'zod/v4'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
declare const inputSchema: () => z.ZodObject<
  {
    task_id: z.ZodOptional<z.ZodString>
    shell_id: z.ZodOptional<z.ZodString>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    message: z.ZodString
    task_id: z.ZodString
    task_type: z.ZodString
    command: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const TaskStopTool: Omit<
  {
    name: string
    searchHint: string
    aliases: string[]
    maxResultSizeChars: number
    userFacingName: () => '' | 'Stop Task'
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    shouldDefer: true
    isConcurrencySafe(): true
    toAutoClassifierInput(input: {
      task_id?: string | undefined
      shell_id?: string | undefined
    }): string
    validateInput(
      {
        task_id,
        shell_id,
      }: {
        task_id?: string | undefined
        shell_id?: string | undefined
      },
      { getAppState }: import('src/Tool.js').ToolUseContext,
    ): Promise<
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
    description(): Promise<string>
    prompt(): Promise<string>
    mapToolResultToToolResultBlockParam(
      output: {
        message: string
        task_id: string
        task_type: string
        command?: string | undefined
      },
      toolUseID: string,
    ): {
      tool_use_id: string
      type: 'tool_result'
      content: string
    }
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolResultMessage: typeof renderToolResultMessage
    call(
      {
        task_id,
        shell_id,
      }: {
        task_id?: string | undefined
        shell_id?: string | undefined
      },
      {
        getAppState,
        setAppState,
        abortController,
      }: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: {
        message: string
        task_id: string
        task_type: string
        command: string | undefined
      }
    }>
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
  userFacingName: () => '' | 'Stop Task'
  isConcurrencySafe: () => true
  isReadOnly: (_input?: unknown) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      [key: string]: unknown
    },
    _ctx?: import('src/Tool.js').ToolUseContext,
  ) => Promise<import('src/types/permissions.js').PermissionResult>
  toAutoClassifierInput: (input: {
    task_id?: string | undefined
    shell_id?: string | undefined
  }) => string
}
export {}
